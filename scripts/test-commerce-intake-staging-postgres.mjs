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
      if (
        specifier
        === '@/lib/integrations/commerceFaireAutomaticPromotion'
      ) {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceFaireAutomaticPromotion.ts',
        )
      }
      if (
        specifier
        === '@/lib/integrations/commerceShopifyAutomaticPromotion'
      ) {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceShopifyAutomaticPromotion.ts',
        )
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

function carrierPartyFingerprint(value) {
  return hash(canonicalJson(value))
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

function faireRetailerOrderFixture(input) {
  const base = orderFixture({
    key: input.key,
    variantId: `po_${input.key}`,
    unitPrice: money(0, 'USD'),
    unfulfilledQuantity: 1,
  })
  const externalOrderId = `faire-order-${input.key}`
  const externalProductId = `p_${input.key}`
  const externalVariantId = `po_${input.key}`
  const line = base.lines[0]
  return Object.freeze({
    ...base,
    identity: Object.freeze({
      provider: 'faire',
      resourceType: 'order',
      value: externalOrderId,
    }),
    orderNumber: `FAIRE-${input.key}`,
    headerMoney: Object.freeze({
      ...base.headerMoney,
      customerChargeEligible: false,
    }),
    party: available(Object.freeze({
      role: 'retailer',
      partyType: 'organization',
      externalIdentity: available(Object.freeze({
        provider: 'faire',
        resourceType: 'retailer',
        value: input.retailerId,
      })),
      organizationName: available('Commerce promotion PostgreSQL customer'),
      contactName: available('Jarrett Crosby'),
      email: available(input.evidenceEmail),
      phone: unavailable(),
    })),
    lines: Object.freeze([Object.freeze({
      ...line,
      identity: Object.freeze({
        provider: 'faire',
        resourceType: 'order_line',
        value: `faire-line-${input.key}`,
      }),
      productIdentity: available(Object.freeze({
        provider: 'faire',
        resourceType: 'product',
        value: externalProductId,
      })),
      variantIdentity: available(Object.freeze({
        provider: 'faire',
        resourceType: 'variant',
        value: externalVariantId,
      })),
      sourceHash: hash(`faire-line:${input.key}`),
    })]),
    readinessFacts: Object.freeze([
      Object.freeze({
        dimension: 'product',
        code: 'product_mapping_required',
        blocking: true,
        subjectExternalId: externalVariantId,
      }),
      Object.freeze({
        dimension: 'customer',
        code: 'customer_resolution_required',
        blocking: true,
        subjectExternalId: null,
      }),
    ]),
    providerFacts: Object.freeze({
      provider: 'faire',
      brandIdentity: available(Object.freeze({
        provider: 'faire',
        resourceType: 'brand',
        value: 'brand-9202',
      })),
      retailerIdentity: available(Object.freeze({
        provider: 'faire',
        resourceType: 'retailer',
        value: input.retailerId,
      })),
      brandDiscount: money(0, 'USD'),
      lineDiscountTotal: money(0, 'USD'),
      payoutState: null,
      payoutAmount: unavailable(),
    }),
    sourceHash: hash(`faire-order:${input.key}`),
  })
}

function fairePackOrderFixture(input) {
  const base = faireRetailerOrderFixture(input)
  return Object.freeze({
    ...base,
    lines: Object.freeze([Object.freeze({
      ...base.lines[0],
      requiresShipping: true,
      packaging: unavailable(),
    })]),
    readinessFacts: Object.freeze([
      ...base.readinessFacts,
      Object.freeze({
        dimension: 'packaging',
        code: 'packaging_required',
        blocking: true,
        subjectExternalId: `po_${input.key}`,
      }),
    ]),
  })
}

function faireProductFixture(input) {
  const productIdentity = Object.freeze({
    provider: 'faire',
    resourceType: 'product',
    value: input.externalProductId,
  })
  return Object.freeze({
    schemaVersion: 'commerce-normalized-product-v1',
    identity: productIdentity,
    brandIdentity: available(Object.freeze({
      provider: 'faire',
      resourceType: 'brand',
      value: 'brand-9202',
    })),
    title: `Faire exact pack ${input.key}`,
    description: null,
    vendor: 'ClawPilot acceptance',
    productType: 'Test',
    providerTaxonomy: unavailable(),
    lifecycleState: 'ACTIVE',
    saleState: 'FOR_SALE',
    active: true,
    providerCreatedAt: observedAt,
    providerUpdatedAt: observedAt,
    imageSetComplete: true,
    images: Object.freeze([]),
    variants: Object.freeze([Object.freeze({
      schemaVersion: 'commerce-normalized-variant-v1',
      identity: Object.freeze({
        provider: 'faire',
        resourceType: 'variant',
        value: input.externalVariantId,
      }),
      productIdentity,
      inventoryItemIdentity: unavailable(),
      sku: `FAIRE-PACK-${input.key}`,
      barcode: null,
      title: 'Default',
      selectedOptions: Object.freeze([]),
      unitMultiplier: 1,
      wholesalePrice: unavailable(),
      retailPrice: unavailable(),
      taxable: false,
      requiresShipping: true,
      inventory: unavailable(),
      packaging: unavailable(),
      weightGrams: 454,
      providerCreatedAt: observedAt,
      providerUpdatedAt: observedAt,
      sourceHash: input.variantSourceHash,
    })]),
    sourceHash: input.productSourceHash,
  })
}

function productImageFixture() {
  const providerImageId = 'gid://shopify/MediaImage/9201001'
  const locatorFingerprint = hash('commerce-staging-product-image-locator')
  return Object.freeze({
    product: Object.freeze({
      schemaVersion: 'commerce-normalized-product-v1',
      identity: Object.freeze({
        provider: 'shopify',
        resourceType: 'product',
        value: 'gid://shopify/Product/9201001',
      }),
      title: 'Commerce staging image-only product',
      vendor: 'ClawPilot acceptance',
      productType: 'Test',
      providerTaxonomy: unavailable(),
      variants: Object.freeze([]),
      images: Object.freeze([Object.freeze({
        providerImageId,
        locatorFingerprint,
        sequence: 1,
        altText: 'Commerce staging image',
        widthPixels: 640,
        heightPixels: 480,
      })]),
      imageSetComplete: true,
      providerCreatedAt: observedAt,
      providerUpdatedAt: observedAt,
      sourceHash: hash('commerce-staging-product-source'),
    }),
    expectedObservation: Object.freeze({
      providerImageId,
      locatorSha256: locatorFingerprint,
      sequence: 1,
      altText: 'Commerce staging image',
      pixelWidth: 640,
      pixelHeight: 480,
      sourceHash: commandHash({
        schema: 'commerce-product-image-observation-v1',
        provider: 'shopify',
        providerImageId,
        locatorSha256: locatorFingerprint,
        sequence: 1,
        altText: 'Commerce staging image',
        pixelWidth: 640,
        pixelHeight: 480,
      }),
    }),
  })
}

async function assertAccountScopeIsLocked(pool, input) {
  const probe = await pool.connect()
  try {
    await probe.query('BEGIN')
    await assert.rejects(
      probe.query(
        `SELECT account.id
         FROM operations_integration_accounts account
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
         WHERE account.organization_id = $1::uuid
           AND account.id = $2::uuid
         FOR UPDATE OF account, activation NOWAIT`,
        [input.organizationId, input.integrationAccountId],
      ),
      (error) => error?.code === '55P03',
      'Image reconciliation must run after the account scope is row-locked',
    )
  } finally {
    await probe.query('ROLLBACK').catch(() => {})
    probe.release()
  }
}

class CommerceIntegrationRequestError extends Error {
  constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
    super(message)
    this.name = 'CommerceIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

function loadShopifyCheckoutRatingPersistence(pool) {
  const currency = loadTypeScriptModule('app_src/lib/currency.ts')
  const postgres = {
    acquireTransactionAdvisoryLock: (client, key) => client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [key],
    ),
    getPostgresPool: () => pool,
    query: (sql, values) => pool.query(sql, values),
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
  }
  return loadTypeScriptModule(
    'app_src/lib/persistence/shopifyCheckoutRating.ts',
    {
      '@/lib/auditWriter': { recordAuditEvent: async () => {} },
      '@/lib/operations/shopifyCheckoutPlanRatePolicy':
        loadTypeScriptModule(
          'app_src/lib/operations/shopifyCheckoutPlanRatePolicy.ts',
          { '../currency.ts': currency },
        ),
      '@/lib/operations/shopifyCheckoutRateWarmPolicy':
        loadTypeScriptModule(
          'app_src/lib/operations/shopifyCheckoutRateWarmPolicy.ts',
        ),
      '@/lib/persistence/postgres': postgres,
    },
  )
}

function loadCommerceStagingService(pool, counters, options = {}) {
  const mustNotRun = (name) => () => {
    throw new Error(`${name} must not run during order-only staging acceptance`)
  }
  const normalization = loadTypeScriptModule(
    'app_src/lib/operations/commerceNormalization.ts',
  )
  const packRuntime = loadTypeScriptModule(
    'app_src/lib/integrations/commercePackRuntime.ts',
  )
  const orderStaging = loadTypeScriptModule(
    'app_src/lib/integrations/commerceOrderStaging.ts',
  )
  const commercePackEvidence = loadTypeScriptModule(
    'app_src/lib/operations/commercePackEvidence.ts',
  )
  const productChannelStates = loadTypeScriptModule(
    'app_src/lib/persistence/productChannelStates.ts',
    {
      '@/lib/operations/commercePackEvidence': commercePackEvidence,
      '@/lib/persistence/postgres': {
        query: mustNotRun('productChannelStates.query'),
      },
    },
  )
  const reconcileCommerceProductImageSetWithClient = async (
    input,
    client,
  ) => {
    const transactionClient = counters.activeTransactionClient
    counters.imageReconcileCalls.push({
      client,
      transactionClient,
      input: JSON.parse(JSON.stringify(input)),
    })
    const expectedStage = counters.expectedImageStage
    assert.ok(expectedStage, 'Image reconciliation requires stage evidence')
    assert.strictEqual(
      client,
      transactionClient,
      'Image reconciliation must share the intake-stage transaction client',
    )
    await assertAccountScopeIsLocked(pool, input)
    const stageEvidence = await client.query(
      `SELECT run.id::text, intent.intent_state, intent.staged_run_id::text
       FROM operations_commerce_intake_runs run
       JOIN operations_commerce_intake_read_intents intent
         ON intent.organization_id = run.organization_id
        AND intent.integration_account_id = run.integration_account_id
       WHERE run.organization_id = $1::uuid
         AND run.integration_account_id = $2::uuid
         AND run.idempotency_key = $3
         AND intent.id = $4::uuid`,
      [
        input.organizationId,
        input.integrationAccountId,
        expectedStage.idempotencyKey,
        expectedStage.readIntentId,
      ],
    )
    assert.equal(stageEvidence.rowCount, 1)
    assert.equal(stageEvidence.rows[0].intent_state, 'captured')
    assert.equal(stageEvidence.rows[0].staged_run_id, null)
    if (counters.imageReconcileError) {
      throw counters.imageReconcileError
    }
    return {
      staleSnapshotIgnored: false,
      active: input.images.map(() => ({ jobState: 'queued' })),
      removed: [],
    }
  }
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceIntake.ts',
    {
      '@/lib/auditWriter': {
        async recordAuditEvent(input, client) {
          counters.auditEvents += 1
          assert.ok(client, 'Commerce intake audit must share its transaction')
          await client.query(
            `INSERT INTO audit_events (
               actor, event_type, aggregate_type, aggregate_id, payload,
               event_key, subject, organization_id, is_system
             ) VALUES (
               $1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9
             )
             ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
            [
              input.actor || null,
              input.eventType,
              input.aggregateType || null,
              input.aggregateId || null,
              JSON.stringify(input.payload || {}),
              input.eventKey || null,
              input.subject || input.actor || null,
              input.organizationId || null,
              input.isSystem === true,
            ],
          )
        },
      },
      '@/lib/integrations/commerceCredentialCrypto': {
        commerceCustomerEvidenceFingerprint(input) {
          return hash([
            'test-only-keyed-customer-evidence',
            input.organizationId,
            input.accountGlobalId,
            input.kind,
            input.value,
          ].join('\0'))
        },
        decryptCommerceIntakeReadResult: mustNotRun(
          'decryptCommerceIntakeReadResult',
        ),
        decryptCommerceIntakeContinuation() {
          return { orderCursor: 'commerce-staging-recovery-cursor' }
        },
        decryptCommerceCandidateSnapshot({ ciphertext }) {
          return JSON.parse(Buffer.from(ciphertext).toString('utf8'))
        },
        encryptCommerceCandidateSnapshot(value) {
          const ciphertext = Buffer.from(JSON.stringify(value), 'utf8')
          return {
            ciphertext,
            iv: Buffer.alloc(12, 7),
            tag: Buffer.alloc(16, 8),
            hash: hash(ciphertext),
            encryptionVersion: 1,
          }
        },
        encryptCommerceIntakeReadResult: mustNotRun(
          'encryptCommerceIntakeReadResult',
        ),
        encryptCommerceIntakeContinuation: mustNotRun(
          'encryptCommerceIntakeContinuation',
        ),
        shopifyCheckoutDestinationFingerprint: () =>
          hash('shopify-clean-path-destination'),
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
        normalizeCommerceProductChannelStatus: () => ({
          raw: 'ACTIVE',
          normalized: 'active',
          providerActive: true,
        }),
      },
      '@/lib/integrations/commerceCanonicalProductIdentity': {
        selectCanonicalCommerceProductIdentity: mustNotRun(
          'selectCanonicalCommerceProductIdentity',
        ),
      },
      '@/lib/integrations/commerceProductChannelOffers': {
        selectCommerceProductChannelOffers: () => ({
          wholesale: null,
          retail: null,
          compareAt: null,
        }),
      },
      '@/lib/integrations/commercePackRuntime': packRuntime,
      '@/lib/integrations/commerceOrderStaging': orderStaging,
      '@/lib/persistence/commerceIntegrations': {},
      '@/lib/persistence/commerceProductImageImports': {
        reconcileCommerceProductImageSetWithClient,
      },
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
          assert.equal(
            counters.activeTransactionClient,
            null,
            'Commerce staging transactions must not overlap in this test',
          )
          counters.activeTransactionClient = client
          try {
            await client.query('BEGIN')
            const result = await operation(client)
            await client.query('COMMIT')
            return result
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {})
            throw error
          } finally {
            counters.activeTransactionClient = null
            client.release()
          }
        },
      },
      '@/lib/persistence/commerceCatalogSync': {
        async applyCommerceCatalogSyncPolicyWithClient(client, input) {
          assert.strictEqual(
            client,
            counters.activeTransactionClient,
            'Catalog policy application must share the policy transaction',
          )
          counters.catalogPolicyApplications.push({ ...input })
          return { queued: 1, cancelled: 0 }
        },
        commerceCatalogCredentialSupportsProducts: mustNotRun(
          'commerceCatalogCredentialSupportsProducts',
        ),
        readCommerceCatalogSyncStateWithClient: mustNotRun(
          'readCommerceCatalogSyncStateWithClient',
        ),
      },
      '@/lib/persistence/productChannelStates': productChannelStates,
      '@/lib/persistence/shopifyCheckoutRating': options
        .shopifyCheckoutRating || {
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

function loadSandboxCommerceE2eAuthorization(pool) {
  const postgres = {
    query: (sql, params = []) => pool.query(sql, params),
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
  }
  return loadTypeScriptModule(
    'app_src/lib/persistence/sandboxCommerceE2eAuthorization.ts',
    {
      '@/lib/auditWriter': {
        async recordAuditEvent(input, client) {
          await client.query(
            `INSERT INTO audit_events (
               actor, event_type, aggregate_type, aggregate_id, payload,
               event_key, subject, organization_id, is_system
             ) VALUES (
               $1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9
             )
             ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
            [
              input.actor || null,
              input.eventType,
              input.aggregateType || null,
              input.aggregateId || null,
              JSON.stringify(input.payload || {}),
              input.eventKey || null,
              input.subject || input.actor || null,
              input.organizationId || null,
              input.isSystem === true,
            ],
          )
        },
      },
      '@/lib/operations/sandboxCommerceE2e': loadTypeScriptModule(
        'app_src/lib/operations/sandboxCommerceE2e.ts',
      ),
      '@/lib/persistence/postgres': postgres,
    },
  )
}

function loadOperationalWarehouseServices(pool) {
  const mustNotRun = (name) => async () => {
    throw new Error(`${name} must not run during warehouse-path acceptance`)
  }
  const postgres = {
    query: (sql, params = []) => pool.query(sql, params),
    getPostgresPool: () => pool,
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
  }
  const auditWriter = { recordAuditEvent: async () => {} }
  const credentialCrypto = {
    decryptCommerceCandidateSnapshot({ ciphertext }) {
      return JSON.parse(Buffer.from(ciphertext).toString('utf8'))
    },
  }
  const carrierSandboxRate = {
    normalizeCarrierSandboxParty: (value) => value,
    carrierSandboxPartyFingerprint: carrierPartyFingerprint,
  }
  const cartonizationRateEvidence = loadTypeScriptModule(
    'app_src/lib/persistence/cartonizationRateEvidence.ts',
    {
      '@/lib/auditWriter': auditWriter,
      '@/lib/integrations/commerceCredentialCrypto': credentialCrypto,
      '@/lib/integrations/carrierSandboxRate': carrierSandboxRate,
      '@/lib/persistence/postgres': postgres,
    },
  )
  const currency = loadTypeScriptModule('app_src/lib/currency.ts')
  const canonicalPlanning = loadTypeScriptModule(
    'app_src/lib/operations/canonicalFulfillmentPlanning.ts',
    { '../currency.ts': currency },
  )
  const stableId = loadTypeScriptModule('app_src/lib/crm/stableId.ts')
  const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts')
  const adapters = loadTypeScriptModule(
    'app_src/lib/operations/adapters.ts',
    { '@/lib/operations/domain': domain },
  )
  const packingSlip = loadTypeScriptModule(
    'app_src/lib/operations/packingSlip.ts',
  )
  const commerceFulfillmentRecoveryPolicy = loadTypeScriptModule(
    'app_src/lib/commerceFulfillmentRecoveryPolicy.ts',
  )
  const operations = loadTypeScriptModule(
    'app_src/lib/persistence/operations.ts',
    {
      '@/lib/auditWriter': auditWriter,
      '@/lib/crm/stableId': stableId,
      '@/lib/integrations/carrierCheckoutRate': {
        rateCheckoutShipment: mustNotRun('rateCheckoutShipment'),
      },
      '@/lib/integrations/carrierIntegrations': {
        testCarrierSandboxShipmentRate: mustNotRun(
          'testCarrierSandboxShipmentRate',
        ),
      },
      '@/lib/integrations/shopifyFulfillmentWriteback': {
        executeShopifyFulfillmentWriteback: mustNotRun(
          'executeShopifyFulfillmentWriteback',
        ),
        prepareShopifyFulfillmentWriteback: mustNotRun(
          'prepareShopifyFulfillmentWriteback',
        ),
        reconcileShopifyFulfillmentWriteback: mustNotRun(
          'reconcileShopifyFulfillmentWriteback',
        ),
      },
      '@/lib/integrations/faireFulfillmentRuntime': {
        prepareCurrentFaireFulfillmentAuthority: mustNotRun(
          'prepareCurrentFaireFulfillmentAuthority',
        ),
        executeCurrentFaireFulfillmentWriteback: mustNotRun(
          'executeCurrentFaireFulfillmentWriteback',
        ),
      },
      '@/lib/commerceFulfillmentRecoveryPolicy':
        commerceFulfillmentRecoveryPolicy,
      '@/lib/operations/adapters': adapters,
      '@/lib/operations/canonicalFulfillmentPlanning': canonicalPlanning,
      '@/lib/operations/domain': domain,
      '@/lib/operations/packingSlip': packingSlip,
      '@/lib/persistence/cartonizationRateEvidence':
        cartonizationRateEvidence,
      '@/lib/persistence/crm': {
        stageCrmRecordWithClient: mustNotRun('stageCrmRecordWithClient'),
      },
      '@/lib/persistence/operationPrintDelivery': {
        enqueueOperationsPrintJobInPostgres: mustNotRun(
          'enqueueOperationsPrintJobInPostgres',
        ),
      },
      '@/lib/persistence/operationShadowFulfillmentPreparation': {
        readShadowFulfillmentPreparation: mustNotRun(
          'readShadowFulfillmentPreparation',
        ),
      },
      '@/lib/persistence/sandboxCommerceE2eAuthorization': {
        readActiveSandboxCommerceE2eAuthorizationForOrderInPostgres:
          mustNotRun(
            'readActiveSandboxCommerceE2eAuthorizationForOrderInPostgres',
          ),
        requireActiveSandboxCommerceE2eAuthorization: mustNotRun(
          'requireActiveSandboxCommerceE2eAuthorization',
        ),
        consumeSandboxCommerceE2eAuthorization: mustNotRun(
          'consumeSandboxCommerceE2eAuthorization',
        ),
      },
      '@/lib/persistence/postgres': postgres,
      '@/lib/persistence/productPackaging': {
        readDefaultProductPackagingWithClient: async () => new Map(),
      },
      '@/lib/persistence/shopifyCheckoutRating': {
        lockShopifyCarrierServiceConfigWritersForActivationWithClient:
          mustNotRun(
            'lockShopifyCarrierServiceConfigWritersForActivationWithClient',
          ),
        rebindRegisteredShopifyCarrierServicesForShadowActivationWithClient:
          mustNotRun(
            'rebindRegisteredShopifyCarrierServicesForShadowActivationWithClient',
          ),
        shopifyCheckoutRateLineageIsRequired: () => false,
        shopifyCheckoutRateOutcomeAllowsFulfillment: () => false,
      },
    },
    {
      AbortController,
      AbortSignal,
      Headers,
      Request,
      Response,
      TextDecoder,
      TextEncoder,
      URL,
      clearTimeout,
      fetch,
      setTimeout,
      structuredClone,
    },
  )
  const hybridCartonization = loadTypeScriptModule(
    'app_src/lib/operations/hybridCartonization.ts',
  )
  return {
    cartonizationRateEvidence,
    hybridCartonization,
    operations,
  }
}

function loadCommerceOrderReconciliationPersistence(pool) {
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderReconciliation.ts',
    {
      '@/lib/auditWriter': {
        async recordAuditEvent(input, client) {
          assert.ok(client, 'Reconciliation audit must share its transaction')
          await client.query(
            `INSERT INTO audit_events (
               actor, event_type, aggregate_type, aggregate_id, payload,
               event_key, subject, organization_id, is_system
             ) VALUES (
               $1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9
             )
             ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
            [
              input.actor || null,
              input.eventType,
              input.aggregateType || null,
              input.aggregateId || null,
              JSON.stringify(input.payload || {}),
              input.eventKey || null,
              input.subject || input.actor || null,
              input.organizationId || null,
              input.isSystem === true,
            ],
          )
        },
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError,
      },
      '@/lib/persistence/postgres': {
        acquireTransactionAdvisoryLock: (client, key) => client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [key],
        ),
        async query(sql, values) {
          return pool.query(sql, values)
        },
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

function loadCommerceOrderReconciliationWorker(input) {
  return loadTypeScriptModule(
    'app_src/lib/commerceOrderReconciliationWorker.ts',
    {
      '@/lib/integrations/commerceIntake': {
        commerceIntakeRuntimeAvailable: () => true,
        executeCommerceOrderPage: input.executeCommerceOrderPage,
      },
      '@/lib/persistence/commerceIntake': {
        async markAutomaticFaireOrderPromotionAttentionInPostgres() {
          return { marked: true }
        },
        async readAutomaticFaireExactRefreshTargetsInPostgres() {
          return []
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        ...input.persistence,
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: target.startedAt,
            recordsSeen: target.recordsSeen,
            recordsHeld: target.recordsHeld,
            continuationBatchNumber: 1,
            providerCursorRepeated: false,
          }
        },
      },
    },
  )
}

async function verifyReviewTerminalCatalogRecovery(input) {
  const {
    pool,
    ids,
    persistence,
    counters,
  } = input
  const deadJobId = randomUUID()
  const registryClient = await pool.connect()
  try {
    await registryClient.query('SET session_replication_role = replica')
    await registryClient.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, entity_type
       ) VALUES (
         'gia0009201', 'gia', 'gia0009201', 'active',
         'operations.integration_account'
       ) ON CONFLICT (reference_code) DO NOTHING`,
    )
  } finally {
    await registryClient.query(
      'SET session_replication_role = origin',
    ).catch(() => {})
    registryClient.release()
  }
  await pool.query(
    `INSERT INTO operations_commerce_product_intake_policies (
       organization_id, integration_account_id, policy_version,
       unmatched_action, revision, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'commerce-product-intake-policy-v1',
       'review', 1, $3, $3
     )`,
    [ids.organization, ids.integrationAccount, actorEmail],
  )
  await pool.query(
    `INSERT INTO operations_commerce_catalog_sync_jobs (
       id, organization_id, integration_account_id, provider,
       credential_version, policy_revision, requested_by, status,
       continuation_run_global_id, last_error_code, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'shopify', 1, 1, $4, 'dead',
       'gcir0009201', 'COMMERCE_CATALOG_SYNC_PROVIDER_FAILED', now()
     )`,
    [deadJobId, ids.organization, ids.integrationAccount, actorEmail],
  )
  const reason = (
    'Operator reviewed the terminal read-only catalog failure and preserved '
    + 'review-only unmatched-product authority.'
  )
  const result = await persistence.updateCommerceProductIntakePolicyInPostgres({
    organizationId: ids.organization,
    accountGlobalId: 'gia0009201',
    actorEmail,
    idempotencyKey: randomUUID(),
    expectedPolicyRevision: 1,
    unmatchedAction: 'review',
    confirmAutoCreateProducts: false,
    confirmCatalogSyncReset: true,
    catalogSyncResetReason: reason,
  })
  assert.equal(result.productIntake.unmatchedAction, 'review')
  assert.equal(result.productIntake.autoCreateNewProducts, false)
  assert.equal(result.productIntake.revision, 2)
  assert.equal(result.catalogSync.queued, 1)
  assert.equal(result.catalogSyncReset.performed, true)
  assert.equal(result.catalogSyncReset.previousPolicyRevision, 1)
  assert.equal(result.catalogSyncReset.policyRevision, 2)
  assert.equal(result.catalogSyncReset.deadEvidencePreserved, true)
  assert.equal(result.catalogSyncReset.reason, reason)
  assert.deepEqual(counters.catalogPolicyApplications.at(-1), {
    organizationId: ids.organization,
    integrationAccountId: ids.integrationAccount,
    provider: 'shopify',
    credentialVersion: 1,
    policyRevision: 2,
    unmatchedAction: 'review',
    actorEmail,
  })
  const policy = (
    await pool.query(
      `SELECT unmatched_action, revision
       FROM operations_commerce_product_intake_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integrationAccount],
    )
  ).rows[0]
  assert.deepEqual(policy, { unmatched_action: 'review', revision: 2 })
  const dead = (
    await pool.query(
      `SELECT status, last_error_code, continuation_run_global_id
       FROM operations_commerce_catalog_sync_jobs
       WHERE id = $1::uuid`,
      [deadJobId],
    )
  ).rows[0]
  assert.deepEqual(dead, {
    status: 'dead',
    last_error_code: 'COMMERCE_CATALOG_SYNC_PROVIDER_FAILED',
    continuation_run_global_id: 'gcir0009201',
  })
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
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1, 'gia0009202', $2, 'faire', 'commerce', 'production',
         'Faire pre-fetch binding acceptance', 'active', '{}'::jsonb,
         'brand-9202', 1, $3, $3
       )`,
      [ids.faireIntegrationAccount, ids.organization, actorEmail],
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
         email, source_payload, source_hash, sync_status, created_by,
         updated_by
       ) VALUES (
         $1, $2, 'commerce-promotion-postgres-customer',
         'customer:commerce-promotion-postgres-customer',
         'Commerce promotion PostgreSQL customer', 'customer', $3,
         '{}'::jsonb, $4, 'synced', $5, $5
       )`,
      [
        ids.customer,
        ids.pipeline,
        'jarrett+warehouse@episcs.com',
        hash('promotion-customer'),
        actorEmail,
      ],
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

async function seedAdditionalCapturedRead(client, ids, input) {
  const integrationAccountId = input.integrationAccountId
    || ids.integrationAccount
  const provider = input.provider || 'shopify'
  const resource = input.resource || 'orders'
  const intakeAction = input.intakeAction || 'fetch'
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO operations_commerce_provider_attempts (
         id, global_id, organization_id, integration_account_id,
         action, adapter_version, idempotency_key, request_hash,
         redacted_request, redacted_response, state, completed_at, created_by
       ) VALUES (
         $1, $2, $3, $4, 'commerce.intake.read',
         'commerce-staging-postgres-v1', $5, $6, $7::jsonb, '{}'::jsonb,
         'succeeded', now(), $8
       )`,
      [
        input.providerAttemptId,
        input.providerAttemptGlobalId,
        ids.organization,
        integrationAccountId,
        input.idempotencyKey,
        hash(`${input.idempotencyKey}:provider-read-request`),
        JSON.stringify(input.redactedRequest || {}),
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
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         1, 'none', $10, 1, NULL, $11::timestamptz, $12, 'captured',
         $13, $14, $15, $16, $17, 2, 1, $18, $18, $19::timestamptz
       )`,
      [
        input.readIntentId,
        ids.organization,
        integrationAccountId,
        ids.pipeline,
        provider,
        resource,
        intakeAction,
        input.idempotencyKey,
        hash(`${input.idempotencyKey}:read-intent-request`),
        input.sessionId,
        observedAt,
        ids.queryHash,
        input.providerAttemptId,
        Buffer.from('[]'),
        Buffer.alloc(12, 3),
        Buffer.alloc(16, 4),
        input.responseHash,
        actorEmail,
        retentionExpiresAt,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function verifyFaireExactVariantPackBinding(
  pool,
  ids,
  persistence,
  counters,
  sandboxAuthorization,
) {
  const warehouseServices = loadOperationalWarehouseServices(pool)
  const runtime = {
    organizationId: ids.organization,
    globalId: 'gia0009202',
    integrationAccountId: ids.faireIntegrationAccount,
    provider: 'faire',
    credentialVersion: 1,
  }
  const scenarios = {
    success: {
      key: 'pack_success',
      externalProductId: 'p_pack_success',
      externalVariantId: 'po_pack_success',
      productSourceHash: hash('faire-pack-success-product'),
      variantSourceHash: hash('faire-pack-success-variant'),
    },
    stale: {
      key: 'pack_stale',
      externalProductId: 'p_pack_stale',
      externalVariantId: 'po_pack_stale',
      productSourceHash: hash('faire-pack-stale-product'),
      variantSourceHash: hash('faire-pack-stale-variant'),
    },
    rejected: {
      key: 'pack_rejected',
      externalProductId: 'p_pack_rejected',
      externalVariantId: 'po_pack_rejected',
      productSourceHash: hash('faire-pack-rejected-product'),
      variantSourceHash: hash('faire-pack-rejected-variant'),
    },
  }
  const setup = await pool.connect()
  let packVersion
  let cartonPackVersion
  try {
    await setup.query('BEGIN')
    for (const scenario of Object.values(scenarios)) {
      const mapping = await setup.query(
        `INSERT INTO operations_product_mappings (
           organization_id, integration_account_id, pipeline_id, product_id,
           channel_sku, external_product_id, external_variant_id,
           mapping_method, mapping_source_revision, active, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
           'exact_variant', $8, true, $9
         )
         RETURNING id::text, global_id`,
        [
          ids.organization,
          ids.faireIntegrationAccount,
          ids.pipeline,
          ids.product,
          `FAIRE-PACK-${scenario.key}`,
          scenario.externalProductId,
          scenario.externalVariantId,
          hash(`faire-pack-mapping:${scenario.key}`),
          actorEmail,
        ],
      )
      scenario.productMappingId = mapping.rows[0].id
      scenario.productMappingGlobalId = mapping.rows[0].global_id
    }
    const profile = await setup.query(
      `INSERT INTO operations_product_pack_profiles (
         organization_id, pipeline_id, product_id, profile_key, profile_name,
         package_level, is_default, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire-exact-each',
         'Faire exact each', 'each', true, 'active', $4, $4
       )
       RETURNING id::text, global_id`,
      [ids.organization, ids.pipeline, ids.product, actorEmail],
    )
    const version = await setup.query(
      `INSERT INTO operations_product_pack_profile_versions (
         organization_id, pipeline_id, product_id, profile_id,
         version_number, lifecycle_state, base_each_quantity,
         unit_of_measure, length_mm, width_mm, height_mm, dimension_basis,
         gross_weight_grams, weight_basis, evidence_type, source, is_current,
         evidence_reference, confirmed_at, confirmed_by, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         1, 'active', 1, 'each', 203, 152, 51, 'outer',
         170, 'customer_stated', 'customer_confirmed', 'manual', true,
         'Disposable PostgreSQL exact Faire pack acceptance', now(), $5, $5
       )
       RETURNING id::text, global_id, row_version::integer`,
      [
        ids.organization,
        ids.pipeline,
        ids.product,
        profile.rows[0].id,
        actorEmail,
      ],
    )
    packVersion = version.rows[0]
    const cartonProfile = await setup.query(
      `INSERT INTO operations_product_pack_profiles (
         organization_id, pipeline_id, product_id, profile_key, profile_name,
         package_level, is_default, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire-exact-carton',
         'Faire exact shipping carton', 'case', false, 'active', $4, $4
       )
       RETURNING id::text`,
      [ids.organization, ids.pipeline, ids.product, actorEmail],
    )
    cartonPackVersion = (await setup.query(
      `INSERT INTO operations_product_pack_profile_versions (
         organization_id, pipeline_id, product_id, profile_id,
         version_number, lifecycle_state, base_each_quantity,
         unit_of_measure, length_mm, width_mm, height_mm, dimension_basis,
         gross_weight_grams, weight_basis, fit_model,
         ships_as_own_package, assembly_policy, evidence_type, source,
         is_current, evidence_reference, confirmed_at, confirmed_by,
         created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         1, 'active', 2, 'case', 230, 180, 80, 'outer',
         190, 'measured', 'rigid_3d', false, 'never', 'measured',
         'manual', true, $5, now(), $6, $6
       )
       RETURNING id::text, global_id, row_version::integer`,
      [
        ids.organization,
        ids.pipeline,
        ids.product,
        cartonProfile.rows[0].id,
        'Disposable PostgreSQL measured Faire shipping carton',
        actorEmail,
      ],
    )).rows[0]
    await setup.query('COMMIT')
  } catch (error) {
    await setup.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    setup.release()
  }

  const orderRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa0009210',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-pack-orders',
    responseHash: hash('commerce-staging-faire-pack-orders-response'),
  }
  const orderSeed = await pool.connect()
  try {
    await seedAdditionalCapturedRead(orderSeed, ids, {
      ...orderRead,
      integrationAccountId: ids.faireIntegrationAccount,
      provider: 'faire',
      resource: 'orders',
      intakeAction: 'fetch',
    })
  } finally {
    orderSeed.release()
  }
  const orders = [scenarios.success, scenarios.stale].map((scenario) => (
    fairePackOrderFixture({
      key: scenario.key,
      retailerId: `retailer-${scenario.key}`,
      evidenceEmail: `${scenario.key}@example.com`,
    })
  ))
  const orderEnvelope = Object.freeze({
    schemaVersion: 'commerce-normalization-envelope-v1',
    normalizerVersion: 'commerce-staging-postgres-v1',
    provider: 'faire',
    organizationId: ids.organization,
    integrationAccountId: ids.faireIntegrationAccount,
    externalAccountId: 'brand-9202',
    apiVersion: '2026-07',
    observedAt,
    credentialGeneration: 1,
    retentionExpiresAt,
    sourceHash: hash('commerce-staging-faire-pack-orders-envelope'),
    products: Object.freeze([]),
    orders: Object.freeze(orders),
    rejections: Object.freeze([]),
  })
  const stagedOrders = await persistence
    .stageCommerceNormalizationEnvelopeInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: orderRead.idempotencyKey,
      envelope: orderEnvelope,
      stageAction: 'fetch',
      page: {
        mode: 'operational',
        resource: 'orders',
        sessionId: orderRead.sessionId,
        batchNumber: 1,
        previousRunGlobalId: null,
        windowStart: null,
        windowEnd: observedAt,
        queryHash: ids.queryHash,
        nextOrderCursor: null,
        providerRowsSeen: orders.length,
        eligibleOrdersSeen: orders.length,
      },
      refreshCandidateGlobalId: null,
      retryRejectionGlobalId: null,
      readIntentId: orderRead.readIntentId,
      capturedResponseHash: orderRead.responseHash,
    })
  assert.equal(stagedOrders.ordersStaged, 2)

  const exactReadOrdinal = new Map([
    ['success', 9211],
    ['stale', 9212],
    ['rejected', 9213],
  ])
  async function stageExactProduct(name) {
    const scenario = scenarios[name]
    const ordinal = exactReadOrdinal.get(name)
    const descriptor = {
      providerAttemptId: randomUUID(),
      providerAttemptGlobalId: `gxa${String(ordinal).padStart(7, '0')}`,
      readIntentId: randomUUID(),
      sessionId: randomUUID(),
      idempotencyKey: `commerce-staging-faire-exact-product-${name}`,
      responseHash: hash(`commerce-staging-faire-exact-product-${name}-response`),
    }
    const targetHash = commandHash(scenario.externalProductId)
    const seed = await pool.connect()
    try {
      await seedAdditionalCapturedRead(seed, ids, {
        ...descriptor,
        integrationAccountId: ids.faireIntegrationAccount,
        provider: 'faire',
        resource: 'products',
        intakeAction: 'fetch-products',
        redactedRequest: {
          targetedRead: true,
          targetHash,
          productsFetched: true,
          readOnly: true,
          providerWrites: 0,
          syncCursorAdvanced: false,
        },
      })
    } finally {
      seed.release()
    }
    const product = faireProductFixture(scenario)
    const envelope = Object.freeze({
      schemaVersion: 'commerce-normalization-envelope-v1',
      normalizerVersion: 'commerce-staging-postgres-v1',
      provider: 'faire',
      organizationId: ids.organization,
      integrationAccountId: ids.faireIntegrationAccount,
      externalAccountId: 'brand-9202',
      apiVersion: '2026-07',
      observedAt,
      credentialGeneration: 1,
      retentionExpiresAt,
      sourceHash: hash(`commerce-staging-faire-exact-product-${name}-envelope`),
      products: Object.freeze([product]),
      orders: Object.freeze([]),
      rejections: Object.freeze([]),
    })
    counters.expectedImageStage = {
      idempotencyKey: descriptor.idempotencyKey,
      readIntentId: descriptor.readIntentId,
    }
    const result = await persistence
      .stageCommerceNormalizationEnvelopeInPostgres({
        runtime,
        actorEmail,
        idempotencyKey: descriptor.idempotencyKey,
        envelope,
        stageAction: 'fetch-products',
        page: {
          mode: 'operational',
          resource: 'products',
          sessionId: descriptor.sessionId,
          batchNumber: 1,
          previousRunGlobalId: null,
          windowStart: null,
          windowEnd: observedAt,
          queryHash: ids.queryHash,
          nextOrderCursor: null,
          providerRowsSeen: 1,
          eligibleOrdersSeen: 1,
        },
        refreshCandidateGlobalId: null,
        retryRejectionGlobalId: null,
        readIntentId: descriptor.readIntentId,
        capturedResponseHash: descriptor.responseHash,
        exactExternalProductIdHash: targetHash,
      })
    assert.equal(result.productVariantsStaged, 1)
    assert.equal(result.exactProductEvidence.externalProductId,
      scenario.externalProductId)
    assert.equal(result.exactProductEvidence.variants.length, 1)
    return { descriptor, envelope, result }
  }

  const exactSuccess = await stageExactProduct('success')
  const exactStale = await stageExactProduct('stale')
  const exactRejectedOld = await stageExactProduct('rejected')

  const rejectionRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa0009214',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-exact-product-rejected-later',
    responseHash: hash(
      'commerce-staging-faire-exact-product-rejected-later-response',
    ),
  }
  const rejectedTargetHash = commandHash(
    scenarios.rejected.externalProductId,
  )
  const rejectionSeed = await pool.connect()
  try {
    await seedAdditionalCapturedRead(rejectionSeed, ids, {
      ...rejectionRead,
      integrationAccountId: ids.faireIntegrationAccount,
      provider: 'faire',
      resource: 'products',
      intakeAction: 'fetch-products',
      redactedRequest: {
        targetedRead: true,
        targetHash: rejectedTargetHash,
        productsFetched: true,
        readOnly: true,
        providerWrites: 0,
        syncCursorAdvanced: false,
      },
    })
  } finally {
    rejectionSeed.release()
  }
  const rejectedChannelBefore = (await pool.query(
    `SELECT global_id, row_version::integer, source_revision, source_hash,
            pack_evidence_hash
     FROM operations_product_channel_states
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_variant_id = $3`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      scenarios.rejected.externalVariantId,
    ],
  )).rows[0]
  assert.ok(rejectedChannelBefore?.global_id)
  const mappingsBeforeRejectedRead = Number((await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_variant_pack_mappings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [ids.organization, ids.faireIntegrationAccount],
  )).rows[0].count)
  const imageCallsBeforeRejectedRead = counters.imageReconcileCalls.length
  await assert.rejects(
    persistence.stageCommerceNormalizationEnvelopeInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: rejectionRead.idempotencyKey,
      envelope: Object.freeze({
        ...exactRejectedOld.envelope,
        sourceHash: hash(
          'commerce-staging-faire-exact-product-rejected-later-envelope',
        ),
        products: Object.freeze([]),
        rejections: Object.freeze([Object.freeze({
          resourceType: 'product',
          externalId: scenarios.rejected.externalProductId,
          sourceHash: hash('faire-pack-rejected-normalization-rejection'),
          errorCode: 'COMMERCE_PRODUCT_RECORD_INVALID',
          safeMessage: 'Provider product was rejected.',
        })]),
      }),
      stageAction: 'fetch-products',
      page: {
        mode: 'operational',
        resource: 'products',
        sessionId: rejectionRead.sessionId,
        batchNumber: 1,
        previousRunGlobalId: null,
        windowStart: null,
        windowEnd: observedAt,
        queryHash: ids.queryHash,
        nextOrderCursor: null,
        providerRowsSeen: 1,
        eligibleOrdersSeen: 0,
      },
      refreshCandidateGlobalId: null,
      retryRejectionGlobalId: null,
      readIntentId: rejectionRead.readIntentId,
      capturedResponseHash: rejectionRead.responseHash,
      exactExternalProductIdHash: rejectedTargetHash,
    }),
    (error) => error?.code === 'COMMERCE_INTAKE_EXACT_PRODUCT_TARGET_MISMATCH',
  )
  assert.equal(
    counters.imageReconcileCalls.length,
    imageCallsBeforeRejectedRead,
    'A rejected exact product must fail before channel or image reconciliation',
  )
  const rejectedChannelAfter = (await pool.query(
    `SELECT global_id, row_version::integer, source_revision, source_hash,
            pack_evidence_hash
     FROM operations_product_channel_states
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_variant_id = $3`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      scenarios.rejected.externalVariantId,
    ],
  )).rows[0]
  assert.deepEqual(rejectedChannelAfter, rejectedChannelBefore)
  assert.equal(Number((await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_variant_pack_mappings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [ids.organization, ids.faireIntegrationAccount],
  )).rows[0].count), mappingsBeforeRejectedRead)
  const rejectedIntent = (await pool.query(
    `SELECT intent_state, staged_run_id::text
     FROM operations_commerce_intake_read_intents
     WHERE id = $1::uuid`,
    [rejectionRead.readIntentId],
  )).rows[0]
  assert.deepEqual(rejectedIntent, {
    intent_state: 'captured',
    staged_run_id: null,
  })

  const candidateRows = await pool.query(
    `SELECT
       candidate.external_order_id,
       candidate.global_id AS candidate_global_id,
       candidate.row_version::integer AS candidate_row_version,
       line.global_id AS line_global_id,
       line.row_version::integer AS line_row_version,
       line.mapping_state,
       line.packaging_state,
       line.external_product_id,
       line.external_variant_id,
       line.product_id::text,
       line.product_mapping_id::text,
       line.commerce_variant_pack_mapping_id::text
     FROM operations_commerce_order_candidates candidate
     JOIN operations_commerce_order_candidate_lines line
       ON line.organization_id = candidate.organization_id
      AND line.integration_account_id = candidate.integration_account_id
      AND line.pipeline_id = candidate.pipeline_id
      AND line.order_candidate_id = candidate.id
     WHERE candidate.organization_id = $1::uuid
       AND candidate.integration_account_id = $2::uuid
       AND candidate.external_order_id = ANY($3::text[])
     ORDER BY candidate.external_order_id`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      orders.map((order) => order.identity.value),
    ],
  )
  assert.equal(candidateRows.rowCount, 2)
  const candidateFor = (scenario) => candidateRows.rows.find(
    (row) => row.external_order_id === `faire-order-${scenario.key}`,
  )
  const successCandidate = candidateFor(scenarios.success)
  const staleCandidate = candidateFor(scenarios.stale)
  for (const row of [successCandidate, staleCandidate]) {
    assert.equal(row.mapping_state, 'resolved')
    assert.equal(row.packaging_state, 'unresolved')
    assert.equal(row.product_id, ids.product)
    assert.ok(row.product_mapping_id)
    assert.equal(row.commerce_variant_pack_mapping_id, null)
  }
  const exactEvidence = (staged, scenario) => ({
    runGlobalId: staged.result.runGlobalId,
    externalProductId: scenario.externalProductId,
    productSourceHash: staged.result.exactProductEvidence.productSourceHash,
    ...staged.result.exactProductEvidence.variants[0],
  })
  const successEvidence = exactEvidence(exactSuccess, scenarios.success)
  const successKey = 'commerce-staging-faire-variant-pack-success'
  const successResult = await persistence
    .resolveCommerceCandidatePackageInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: successKey,
      candidateGlobalId: successCandidate.candidate_global_id,
      candidateRowVersion: successCandidate.candidate_row_version,
      lineGlobalId: successCandidate.line_global_id,
      package: {
        mode: 'variant_mapping',
        externalProductId: scenarios.success.externalProductId,
        externalVariantId: scenarios.success.externalVariantId,
        packProfileVersionGlobalId: packVersion.global_id,
        expectedPackProfileVersionRowVersion: packVersion.row_version,
        exactProductReadEvidence: successEvidence,
      },
    })
  assert.equal(successResult.mappingCreated, true)
  assert.equal(successResult.exactProductRunGlobalId,
    exactSuccess.result.runGlobalId)
  assert.equal(successResult.channelStateGlobalId,
    successEvidence.channelStateGlobalId)
  const successState = (await pool.query(
    `SELECT
       line.packaging_state,
       line.packaging_source,
       line.packaging_weight_source,
       line.row_version::integer AS line_row_version,
       line.commerce_variant_pack_mapping_id::text,
       line.pack_profile_version_id::text,
       receipt.status AS receipt_status,
       receipt.completed_at IS NOT NULL AS receipt_completed,
       mapping.global_id AS mapping_global_id,
       mapping.pack_evidence_hash
     FROM operations_commerce_order_candidate_lines line
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = line.organization_id
      AND candidate.id = line.order_candidate_id
     JOIN operations_command_receipts receipt
       ON receipt.organization_id = candidate.organization_id
      AND receipt.command_type = 'commerce.intake.resolve_package'
      AND receipt.idempotency_key = $3
     JOIN operations_commerce_variant_pack_mappings mapping
       ON mapping.organization_id = line.organization_id
      AND mapping.id = line.commerce_variant_pack_mapping_id
     WHERE line.organization_id = $1::uuid
       AND line.global_id = $2`,
    [ids.organization, successCandidate.line_global_id, successKey],
  )).rows[0]
  assert.equal(successState.packaging_state, 'resolved')
  assert.equal(successState.packaging_source, 'variant_pack_mapping')
  assert.equal(successState.packaging_weight_source, 'profile_version')
  assert.ok(
    successState.line_row_version > successCandidate.line_row_version,
  )
  assert.ok(successState.commerce_variant_pack_mapping_id)
  assert.equal(successState.pack_profile_version_id, packVersion.id)
  assert.equal(successState.receipt_status, 'succeeded')
  assert.equal(successState.receipt_completed, true)
  assert.equal(
    successState.mapping_global_id,
    successResult.variantPackMappingGlobalId,
  )
  assert.equal(
    successState.pack_evidence_hash,
    successEvidence.channelPackEvidenceHash,
  )

  const staleEvidence = exactEvidence(exactStale, scenarios.stale)
  const rollbackSnapshot = async () => ({
    line: (await pool.query(
      `SELECT row_version::integer, packaging_state, packaging_source,
              packaging_weight_source,
              commerce_variant_pack_mapping_id::text,
              pack_profile_version_id::text
       FROM operations_commerce_order_candidate_lines
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [ids.organization, staleCandidate.line_global_id],
    )).rows[0],
    candidate: (await pool.query(
      `SELECT row_version::integer, workflow_state
       FROM operations_commerce_order_candidates
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [ids.organization, staleCandidate.candidate_global_id],
    )).rows[0],
    mappingCount: Number((await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_commerce_variant_pack_mappings
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.faireIntegrationAccount],
    )).rows[0].count),
  })
  const assertRolledBack = async (before, key) => {
    const after = await rollbackSnapshot()
    assert.deepEqual(after, before)
    const receipts = (await pool.query(
      `SELECT count(*)::integer AS total,
              count(*) FILTER (WHERE status = 'succeeded')::integer
                AS completed
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'commerce.intake.resolve_package'
         AND idempotency_key = $2`,
      [ids.organization, key],
    )).rows[0]
    assert.deepEqual(receipts, { total: 0, completed: 0 })
  }
  const tamperedBefore = await rollbackSnapshot()
  const tamperedKey = 'commerce-staging-faire-variant-pack-tampered-evidence'
  await assert.rejects(
    persistence.resolveCommerceCandidatePackageInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: tamperedKey,
      candidateGlobalId: staleCandidate.candidate_global_id,
      candidateRowVersion: staleCandidate.candidate_row_version,
      lineGlobalId: staleCandidate.line_global_id,
      package: {
        mode: 'variant_mapping',
        externalProductId: scenarios.stale.externalProductId,
        externalVariantId: scenarios.stale.externalVariantId,
        packProfileVersionGlobalId: packVersion.global_id,
        expectedPackProfileVersionRowVersion: packVersion.row_version,
        exactProductReadEvidence: {
          ...staleEvidence,
          productSourceHash: hash('tampered-product-source'),
        },
      },
    }),
    (error) => error?.code === 'COMMERCE_INTAKE_EXACT_PRODUCT_EVIDENCE_REQUIRED',
  )
  await assertRolledBack(tamperedBefore, tamperedKey)

  const advancedChannel = await pool.query(
    `UPDATE operations_product_channel_states
     SET provider_updated_at = '2026-08-01T18:00:00.000Z'::timestamptz,
         observed_at = '2026-08-01T18:00:00.000Z'::timestamptz,
         source_revision = '2026-08-01T18:00:00.000Z',
         source_hash = $4,
         row_version = row_version + 1,
         updated_by = $5,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND global_id = $3
     RETURNING row_version::integer, source_hash`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      staleEvidence.channelStateGlobalId,
      hash('newer-faire-pack-channel-observation'),
      actorEmail,
    ],
  )
  assert.equal(
    advancedChannel.rows[0].row_version,
    staleEvidence.channelStateRowVersion + 1,
  )
  const staleBefore = await rollbackSnapshot()
  const staleKey = 'commerce-staging-faire-variant-pack-stale-evidence'
  await assert.rejects(
    persistence.resolveCommerceCandidatePackageInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: staleKey,
      candidateGlobalId: staleCandidate.candidate_global_id,
      candidateRowVersion: staleCandidate.candidate_row_version,
      lineGlobalId: staleCandidate.line_global_id,
      package: {
        mode: 'variant_mapping',
        externalProductId: scenarios.stale.externalProductId,
        externalVariantId: scenarios.stale.externalVariantId,
        packProfileVersionGlobalId: packVersion.global_id,
        expectedPackProfileVersionRowVersion: packVersion.row_version,
        exactProductReadEvidence: staleEvidence,
      },
    }),
    (error) => error?.code === 'COMMERCE_INTAKE_EXACT_PRODUCT_STATE_REQUIRED',
  )
  await assertRolledBack(staleBefore, staleKey)

  const sideEffectsBeforeAuthorization = (await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_provider_attempts
        WHERE organization_id = $1::uuid) AS provider_attempts,
       (SELECT count(*)::integer
        FROM operations_labels
        WHERE organization_id = $1::uuid) AS labels,
       (SELECT count(*)::integer
        FROM operations_commerce_fulfillment_exports
        WHERE organization_id = $1::uuid) AS fulfillment_exports`,
    [ids.organization],
  )).rows[0]

  const promotionSeed = await pool.connect()
  let promotableCandidate
  try {
    await promotionSeed.query('BEGIN')
    await promotionSeed.query('SET LOCAL session_replication_role = replica')
    const candidateUpdate = await promotionSeed.query(
      `UPDATE operations_commerce_order_candidates
       SET customer_resolution_state = 'resolved',
           customer_match_method = 'manual_test_fixture',
           customer_id = $3::uuid,
           requires_shipping = false,
           delivery_resolution_state = 'not_required',
           requested_delivery_at = NULL,
           workflow_state = 'ready',
           blocking_codes = '{}'::text[],
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
       RETURNING global_id, row_version::integer`,
      [
        ids.organization,
        successCandidate.candidate_global_id,
        ids.customer,
        actorEmail,
      ],
    )
    assert.equal(candidateUpdate.rowCount, 1)
    promotableCandidate = candidateUpdate.rows[0]
    const lineUpdate = await promotionSeed.query(
      `UPDATE operations_commerce_order_candidate_lines
       SET workflow_state = 'ready',
           blocking_codes = '{}'::text[],
           row_version = row_version + 1,
           updated_by = $3,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
       RETURNING id`,
      [ids.organization, successCandidate.line_global_id, actorEmail],
    )
    assert.equal(lineUpdate.rowCount, 1)
    await promotionSeed.query('COMMIT')
  } catch (error) {
    await promotionSeed.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    promotionSeed.release()
  }

  const promoted = await persistence.promoteCommerceCandidateInPostgres({
    runtime,
    actorEmail,
    idempotencyKey: 'commerce-staging-faire-sandbox-e2e-promotion',
    candidateGlobalId: promotableCandidate.global_id,
    candidateRowVersion: promotableCandidate.row_version,
    requestHash: hash('commerce-staging-faire-sandbox-e2e-promotion'),
  })
  assert.equal(promoted.providerWrites, 0)
  assert.equal(promoted.fulfillmentWrites, 0)
  assert.equal(promoted.shipmentWrites, 0)

  const destination = {
    name: 'Jarrett Crosby',
    line1: '16691 Gothard St',
    line2: 'Suite Q',
    city: 'Huntington Beach',
    region: 'California',
    postalCode: '92647',
    country: 'US',
  }
  const operationalSeed = await pool.connect()
  let operational
  try {
    await operationalSeed.query('BEGIN')
    const order = await operationalSeed.query(
      `UPDATE operations_orders
       SET ship_to = $3::jsonb,
           requested_delivery_at = now() + interval '5 days',
           updated_by = $4, updated_at = now(),
           row_version = row_version + 1
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND status = 'imported'
       RETURNING id::text, global_id, row_version::integer`,
      [
        ids.organization,
        promoted.canonicalOrderGlobalId,
        JSON.stringify(destination),
        actorEmail,
      ],
    )
    assert.equal(order.rowCount, 1)
    const orderId = order.rows[0].id
    const candidate = await operationalSeed.query(
      `UPDATE operations_commerce_order_candidates
       SET ship_to_snapshot_state = 'confirmed',
           ship_to_snapshot_source = 'provider',
           ship_to_snapshot_ciphertext = $3::bytea,
           ship_to_snapshot_iv = decode(repeat('00', 12), 'hex'),
           ship_to_snapshot_tag = decode(repeat('00', 16), 'hex'),
           ship_to_snapshot_hash = $4,
           ship_to_snapshot_encryption_version = 1,
           delivery_resolution_state = 'manual',
           requested_delivery_at = now() + interval '5 days',
           row_version = row_version + 1,
           updated_by = $5,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND workflow_state = 'promoted'
       RETURNING id::text, global_id, row_version::integer, source_hash`,
      [
        ids.organization,
        successCandidate.candidate_global_id,
        Buffer.from(JSON.stringify(destination)),
        hash(canonicalJson(destination)),
        actorEmail,
      ],
    )
    assert.equal(candidate.rowCount, 1)
    const warehouse = await operationalSeed.query(
      `INSERT INTO operations_warehouses (
         organization_id, code, name, timezone, address,
         status, created_by, updated_by
       ) VALUES (
         $1::uuid, 'FAIRE-E2E', 'Faire sandbox E2E warehouse',
         'America/Los_Angeles', $2::jsonb, 'active', $3, $3
       ) RETURNING id::text, global_id`,
      [
        ids.organization,
        JSON.stringify({
          name: 'ClawPilot test warehouse',
          line1: '16691 Gothard St',
          line2: 'Suite Q',
          city: 'Huntington Beach',
          region: 'CA',
          postalCode: '92647',
          country: 'US',
        }),
        actorEmail,
      ],
    )
    const location = await operationalSeed.query(
      `INSERT INTO operations_locations (
         organization_id, warehouse_id, code, zone, location_type,
         pick_sequence, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'FAIRE-PICK-01', 'PICK', 'pick',
         1, true, $3
       ) RETURNING id::text, global_id`,
      [ids.organization, warehouse.rows[0].id, actorEmail],
    )
    const inventoryPool = await operationalSeed.query(
      `INSERT INTO operations_inventory_pools (
         organization_id, pipeline_id, name, pool_type,
         allocation_policy, active, created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'Faire E2E local inventory',
         'shared', 'fifo', true, $3
       ) RETURNING id::text`,
      [ids.organization, ids.pipeline, actorEmail],
    )
    const inventoryPosition = await operationalSeed.query(
      `INSERT INTO operations_inventory_positions (
         organization_id, pipeline_id, warehouse_id, location_id,
         pool_id, product_id, lot_code, on_hand_quantity,
         reserved_quantity, damaged_quantity, source_authority
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, 'FAIRE-E2E', 1, 0, 0, 'clawpilot'
       ) RETURNING id::text, global_id`,
      [
        ids.organization,
        ids.pipeline,
        warehouse.rows[0].id,
        location.rows[0].id,
        inventoryPool.rows[0].id,
        ids.product,
      ],
    )
    const material = await operationalSeed.query(
      `INSERT INTO operations_packaging_materials (
         organization_id, code, name, material_type,
         inner_length_mm, inner_width_mm, inner_height_mm,
         tare_weight_grams, max_weight_grams, unit_cost_minor,
         currency, status, source,
         dimension_basis, dimension_evidence_type,
         dimension_evidence_reference, dimension_confirmed_at,
         dimension_confirmed_by,
         rated_outer_length_mm, rated_outer_width_mm,
         rated_outer_height_mm, rated_outer_dimension_evidence_type,
         rated_outer_dimension_evidence_reference,
         rated_outer_dimension_confirmed_at,
         rated_outer_dimension_confirmed_by,
         created_by, updated_by
       ) VALUES (
         $1::uuid, 'FAIRE-E2E-CARTON', 'Faire E2E measured carton', 'carton',
         220, 170, 70, 20, 1000, 55,
         'USD', 'active', 'manual',
         'inner', 'measured', $2, now(), $3,
         230, 180, 80, 'measured', $2, now(), $3,
         $3, $3
       ) RETURNING id::text, global_id, row_version::integer`,
      [
        ids.organization,
        'Disposable PostgreSQL measured Faire carton',
        actorEmail,
      ],
    )
    const materialStock = await operationalSeed.query(
      `INSERT INTO operations_packaging_material_stock (
         organization_id, packaging_material_id, warehouse_id,
         is_available, on_hand_quantity, reorder_point_quantity,
         reorder_to_quantity, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         true, 1, 0, 1, $4, $4
       ) RETURNING id::text`,
      [
        ids.organization,
        material.rows[0].id,
        warehouse.rows[0].id,
        actorEmail,
      ],
    )
    const recipe = await operationalSeed.query(
      `INSERT INTO operations_approved_pack_recipes (
         organization_id, pipeline_id, product_id, recipe_key, recipe_name,
         version_number, input_pack_profile_version_id,
         output_pack_profile_version_id, packaging_material_id,
         input_quantity, output_quantity, packaging_material_quantity,
         recipe_type, fulfillment_policy, remainder_policy,
         inventory_evidence_requirement, assembly_policy, exclusive_contents,
         minimum_input_quantity, content_compatibility_key,
         allows_mixed_products, lifecycle_state, fit_evidence_type,
         fit_evidence_reference, confirmed_at, confirmed_by, source,
         is_current, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'faire-e2e-exact-carton', 'Faire E2E exact carton',
         1, $4::uuid, $5::uuid, $6::uuid,
         2, 1, 1, 'max_capacity', 'case_required', 'block',
         'each_assembly_allowed', 'allowed', true,
         1, NULL, false, 'active', 'measured', $7,
         now(), $8, 'manual', true, $8, $8
       ) RETURNING id::text, global_id, row_version::integer`,
      [
        ids.organization,
        ids.pipeline,
        ids.product,
        packVersion.id,
        cartonPackVersion.id,
        material.rows[0].id,
        'Disposable PostgreSQL exact Faire carton fit',
        actorEmail,
      ],
    )
    const canonicalLine = await operationalSeed.query(
      `SELECT line.id::text, line.global_id,
              product.reference_code AS product_global_id,
              line.description
       FROM operations_order_lines
         line
       JOIN crm_products product
         ON product.pipeline_id = line.pipeline_id
        AND product.id = line.product_id
       WHERE line.organization_id = $1::uuid
         AND line.order_id = $2::uuid`,
      [ids.organization, orderId],
    )
    assert.equal(canonicalLine.rowCount, 1)
    const carrierAccounts = {}
    for (const carrier of [
      { provider: 'ups_rest', name: 'Faire E2E UPS', lastFour: '9201' },
      { provider: 'fedex_rest', name: 'Faire E2E FedEx', lastFour: '9202' },
    ]) {
      const connection = await operationalSeed.query(
        `INSERT INTO operations_integration_accounts (
           organization_id, provider, integration_type, environment,
           display_name, status, configuration, created_by, updated_by
         ) VALUES (
           $1::uuid, $2, 'carrier', 'sandbox',
           $3, 'active', '{}'::jsonb, $4, $4
         ) RETURNING id::text`,
        [ids.organization, carrier.provider, carrier.name, actorEmail],
      )
      const carrierAccount = await operationalSeed.query(
        `INSERT INTO operations_carrier_accounts (
           organization_id, integration_account_id, display_name,
           sender_name, account_number_ciphertext, account_number_iv,
           account_number_tag, account_number_last_four,
           account_number_fingerprint, registered_address,
           registered_address_fingerprint, address_verification,
           status, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3,
           'Faire E2E warehouse', $4, $5, $6, $7, $8,
           $9::jsonb, $10, 'operator_attested', 'active', $11, $11
         ) RETURNING id::text`,
        [
          ids.organization,
          connection.rows[0].id,
          `${carrier.name} account`,
          `${carrier.provider}-ciphertext`,
          `${carrier.provider}-iv`,
          `${carrier.provider}-tag`,
          carrier.lastFour,
          hash(`${carrier.provider}:account`),
          JSON.stringify({
            name: 'Faire E2E warehouse',
            line1: '16691 Gothard St',
            line2: 'Suite Q',
            city: 'Huntington Beach',
            region: 'CA',
            postalCode: '92647',
            countryCode: 'US',
          }),
          hash(`${carrier.provider}:registered-address`),
          actorEmail,
        ],
      )
      carrierAccounts[carrier.provider] = {
        integrationAccountId: connection.rows[0].id,
        carrierAccountId: carrierAccount.rows[0].id,
      }
    }
    operational = {
      order: order.rows[0],
      candidate: candidate.rows[0],
      canonicalLine: canonicalLine.rows[0],
      warehouse: warehouse.rows[0],
      location: location.rows[0],
      inventoryPool: inventoryPool.rows[0],
      inventoryPosition: inventoryPosition.rows[0],
      material: material.rows[0],
      materialStock: materialStock.rows[0],
      recipe: recipe.rows[0],
      carrierAccounts,
    }
    await operationalSeed.query('COMMIT')
  } catch (error) {
    await operationalSeed.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    operationalSeed.release()
  }

  const candidateContext = await warehouseServices
    .cartonizationRateEvidence.readCartonizationRateCandidateContext({
      organizationId: ids.organization,
      accountGlobalId: runtime.globalId,
      candidateGlobalId: operational.candidate.global_id,
      expectedCandidateRowVersion: operational.candidate.row_version,
    })
  assert.equal(candidateContext.destination.region, 'California')
  assert.equal(candidateContext.destination.countryCode, 'US')

  const cartonizationPlan = warehouseServices.hybridCartonization
    .planHybridCartonization({
      mode: 'production',
      lines: [{
        lineGlobalId: successCandidate.line_global_id,
        productGlobalId: operational.canonicalLine.product_global_id,
        title: operational.canonicalLine.description,
        quantity: 1,
        unitWeightGrams: 170,
        profile: {
          versionGlobalId: packVersion.global_id,
          capturedRowVersion: packVersion.row_version,
          currentRowVersion: packVersion.row_version,
          isCurrent: true,
          lifecycleState: 'active',
          fitModel: 'rigid_3d',
          evidenceType: 'customer_confirmed',
          evidenceReference:
            'Disposable PostgreSQL exact Faire pack acceptance',
          confirmedAt: observedAt,
          packageLevel: 'each',
          baseEachQuantity: 1,
          shipsAsOwnPackage: false,
          outerDimensionsMm: { length: 203, width: 152, height: 51 },
          grossWeightGrams: 170,
        },
      }],
      recipes: [{
        recipeGlobalId: operational.recipe.global_id,
        productGlobalId: operational.canonicalLine.product_global_id,
        inputPackProfileVersionGlobalId: packVersion.global_id,
        outputPackProfileVersionGlobalId: cartonPackVersion.global_id,
        packagingMaterialGlobalId: operational.material.global_id,
        recipeType: 'max_capacity',
        maximumInputQuantity: 2,
        minimumInputQuantity: 1,
        contentCompatibilityKey: null,
        allowsMixedProducts: false,
        exclusiveContents: true,
        capturedRowVersion: operational.recipe.row_version,
        currentRowVersion: operational.recipe.row_version,
        isCurrent: true,
        lifecycleState: 'active',
        fitEvidenceType: 'measured',
        fitEvidenceReference:
          'Disposable PostgreSQL exact Faire carton fit',
        confirmedAt: observedAt,
      }],
      materials: [{
        materialGlobalId: operational.material.global_id,
        capturedRowVersion: operational.material.row_version,
        currentRowVersion: operational.material.row_version,
        isCurrent: true,
        status: 'active',
        innerDimensionsMm: { length: 220, width: 170, height: 70 },
        dimensionBasis: 'inner',
        dimensionEvidenceType: 'measured',
        dimensionEvidenceReference:
          'Disposable PostgreSQL measured Faire carton',
        dimensionConfirmedAt: observedAt,
        tareWeightGrams: 20,
        maximumGrossWeightGrams: 1000,
        availableQuantity: 1,
        ratedOuterDimensionsMm: { length: 230, width: 180, height: 80 },
      }],
    })
  assert.equal(cartonizationPlan.status, 'ready')
  assert.equal(cartonizationPlan.geometryFallbackLines.length, 0)
  assert.equal(cartonizationPlan.recipePackages.length, 1)
  const recipePackage = cartonizationPlan.recipePackages[0]
  assert.equal(recipePackage.planningMethod, 'approved_recipe')
  assert.equal(recipePackage.contentWeightGrams, 170)
  assert.equal(recipePackage.rateReadiness.status, 'ready')
  assert.equal(recipePackage.rateReadiness.ratedOuterDimensionsMm.length, 230)
  assert.equal(recipePackage.rateReadiness.ratedOuterDimensionsMm.width, 180)
  assert.equal(recipePackage.rateReadiness.ratedOuterDimensionsMm.height, 80)
  assert.equal(recipePackage.rateReadiness.tareWeightGrams, 20)
  assert.equal(recipePackage.rateReadiness.ratedWeightGrams, 190)
  assert.equal(recipePackage.rateReadiness.blockers.length, 0)
  const roundCarrierDecimal = (value) => Math.round(value * 1_000) / 1_000
  const carrierParcel = {
    description: 'Operational cartonized Faire E2E order',
    length: roundCarrierDecimal(230 / 25.4),
    width: roundCarrierDecimal(180 / 25.4),
    height: roundCarrierDecimal(80 / 25.4),
    dimensionUnit: 'IN',
    weight: roundCarrierDecimal(190 / 453.59237),
    weightUnit: 'LB',
  }
  const rateEvidence = {}
  for (const [provider, carrier] of Object.entries(
    operational.carrierAccounts,
  )) {
    const requestHash = hash(`faire-e2e-${provider}-shipment-rate`)
    rateEvidence[provider] = (await pool.query(
      `INSERT INTO operations_carrier_rate_requests (
         organization_id, integration_account_id, carrier_account_id,
         provider, environment, purpose, adapter_version,
         credential_version, request_hash, redacted_request,
         redacted_response, status, actor_email, requested_at, completed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         $4, 'sandbox', 'cartonization_shipment_rate',
         'faire-e2e-acceptance-v1', 1, $5, $6::jsonb,
         $7::jsonb, 'succeeded', $8,
         now() - interval '1 second', now()
       ) RETURNING id::text, global_id`,
      [
        ids.organization,
        carrier.integrationAccountId,
        carrier.carrierAccountId,
        provider,
        requestHash,
        JSON.stringify({
          shipment: {
            destinationFingerprint:
              candidateContext.destinationFingerprint,
            rateScope: 'multi_package_shipment',
            packageCount: 1,
            parcels: [carrierParcel],
          },
        }),
        JSON.stringify({
          rateScope: 'multi_package_shipment',
          packageCount: 1,
          rateCount: 1,
          rates: [{
            serviceCode: provider === 'ups_rest'
              ? 'ground'
              : 'fedex_ground',
            serviceName: provider === 'ups_rest'
              ? 'UPS Ground'
              : 'FedEx Ground',
            amount: provider === 'ups_rest' ? '12.50' : '13.25',
            currency: 'USD',
            rateType: 'account',
            transitDays: provider === 'ups_rest' ? 3 : 2,
            deliveryDate: null,
          }],
        }),
        actorEmail,
      ],
    )).rows[0]
  }
  const recipes = [...new Map(recipePackage.lineAllocations.map(
    (allocation) => [allocation.recipeGlobalId, {
      recipeGlobalId: allocation.recipeGlobalId,
      recipeRowVersion: allocation.recipeRowVersion,
      productGlobalId: allocation.productGlobalId,
      inputProfileVersionGlobalId: allocation.profileVersionGlobalId,
      inputProfileVersionRowVersion: allocation.profileVersionRowVersion,
    }],
  )).values()]
  const packageSnapshot = {
    packageKey: recipePackage.packageKey,
    packageSequence: recipePackage.sequence,
    planningMethod: recipePackage.planningMethod,
    packagingMaterialGlobalId: recipePackage.packagingMaterialGlobalId,
    materialRowVersion: recipePackage.packagingMaterialRowVersion,
    recipes,
    innerDimensionsMm: recipePackage.materialEvidence.innerDimensionsMm,
    ratedOuterDimensionsMm:
      recipePackage.rateReadiness.ratedOuterDimensionsMm,
    contentWeightGrams: recipePackage.contentWeightGrams,
    tareWeightGrams: recipePackage.rateReadiness.tareWeightGrams,
    ratedGrossWeightGrams: recipePackage.rateReadiness.ratedWeightGrams,
    maxWeightGrams: 1000,
    allocations: recipePackage.lineAllocations.map((allocation) => ({
      lineGlobalId: allocation.lineGlobalId,
      productGlobalId: allocation.productGlobalId,
      title: allocation.title,
      quantity: allocation.quantity,
    })),
    carrierParcel,
  }
  const packageInput = {
    ...packageSnapshot,
    packageHash: warehouseServices.cartonizationRateEvidence
      .cartonizationRateEvidenceHash(packageSnapshot),
  }
  const materialFacts = [{
    materialGlobalId: operational.material.global_id,
    expectedRowVersion: operational.material.row_version,
    ratedOuterDimensionsMm: { length: 230, width: 180, height: 80 },
    tareWeightGrams: 20,
  }]
  const planSnapshot = JSON.parse(JSON.stringify({
    mode: 'production',
    carrierReadEnvironment: 'sandbox',
    policyVersion: cartonizationPlan.policyVersion,
    algorithmVersion: cartonizationPlan.algorithmVersion,
    inputHash: cartonizationPlan.inputHash,
    domainResultHash: cartonizationPlan.resultHash,
    status: cartonizationPlan.status,
    recipePackages: cartonizationPlan.recipePackages,
    geometryFallbackLines: cartonizationPlan.geometryFallbackLines,
    assumptions: cartonizationPlan.assumptions,
    blockers: cartonizationPlan.blockers,
  }))
  const semanticRequestHash = hash('faire-e2e-operational-cartonization')
  const evidenceIdempotencyKey =
    'commerce-staging-faire-operational-cartonization'
  const cartonizationClaim = await warehouseServices.cartonizationRateEvidence
    .claimCartonizationRateEvidenceCommandInPostgres({
      organizationId: ids.organization,
      idempotencyKey: evidenceIdempotencyKey,
      semanticRequestHash,
      actorEmail,
    })
  assert.equal(cartonizationClaim.state, 'claimed')
  const cartonizationEvidenceInput = JSON.parse(JSON.stringify({
      organizationId: ids.organization,
      accountGlobalId: runtime.globalId,
      candidateGlobalId: operational.candidate.global_id,
      candidateRowVersion: operational.candidate.row_version,
      destinationFingerprint: candidateContext.destinationFingerprint,
      warehouseGlobalId: operational.warehouse.global_id,
      inventorySyncRunGlobalId: null,
      evidenceMode: 'operational',
      policyVersion: cartonizationPlan.policyVersion,
      algorithmVersion: cartonizationPlan.algorithmVersion,
      planInputHash: cartonizationPlan.inputHash,
      planResultHash: warehouseServices.cartonizationRateEvidence
        .cartonizationRateEvidenceHash(planSnapshot),
      planSnapshot,
      assumptionSnapshot: { operationalMaterialFacts: materialFacts },
      status: 'succeeded',
      idempotencyKey: evidenceIdempotencyKey,
      actorEmail,
      semanticRequestHash,
      materialRateAssumptions: materialFacts,
      packages: [packageInput],
      quotes: [
        {
          packageKey: recipePackage.packageKey,
          provider: 'ups_rest',
          rateEvidenceGlobalId: rateEvidence.ups_rest.global_id,
        },
        {
          packageKey: recipePackage.packageKey,
          provider: 'fedex_rest',
          rateEvidenceGlobalId: rateEvidence.fedex_rest.global_id,
        },
      ],
    }))
  for (const field of [
    'organizationId',
    'accountGlobalId',
    'candidateGlobalId',
    'candidateRowVersion',
    'destinationFingerprint',
    'warehouseGlobalId',
    'inventorySyncRunGlobalId',
    'evidenceMode',
    'policyVersion',
    'algorithmVersion',
    'planInputHash',
    'planResultHash',
    'planSnapshot',
    'assumptionSnapshot',
    'status',
    'idempotencyKey',
    'actorEmail',
    'semanticRequestHash',
    'materialRateAssumptions',
    'packages',
    'quotes',
  ]) {
    assert.ok(
      Object.hasOwn(cartonizationEvidenceInput, field),
      `Faire operational cartonization evidence is missing ${field}`,
    )
  }
  const cartonizationEvidence = await warehouseServices
    .cartonizationRateEvidence.writeCartonizationRateEvidenceInPostgres(
      cartonizationEvidenceInput,
    )
  assert.equal(cartonizationEvidence.evidenceMode, 'operational')
  assert.equal(cartonizationEvidence.inventorySyncRunGlobalId, null)
  assert.equal(cartonizationEvidence.packages.length, 1)

  // Reproduce the operator flow where exact carton evidence is sealed while
  // the candidate is ready and promotion performs the sole later row bump.
  // The evidence remains bound to the same provider source and destination.
  const auditedPromotionBump = await pool.query(
    `WITH bumped AS (
       UPDATE operations_commerce_order_candidates
       SET row_version = row_version + 1,
           updated_by = $3,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND row_version = $4::bigint
       RETURNING row_version::integer, updated_at
     ), recorded AS (
       INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload,
         event_key, subject, organization_id, is_system, created_at
       )
       SELECT
         $3, 'commerce.intake.promoted', 'operations.order', $5,
         jsonb_build_object('candidateGlobalId', $2),
         'commerce-staging-faire-post-evidence-promotion',
         $3, $1::uuid, false, bumped.updated_at
       FROM bumped
       RETURNING id
     )
     SELECT bumped.row_version
     FROM bumped
     JOIN recorded ON true`,
    [
      ids.organization,
      operational.candidate.global_id,
      actorEmail,
      operational.candidate.row_version,
      promoted.canonicalOrderGlobalId,
    ],
  )
  assert.equal(auditedPromotionBump.rowCount, 1)
  assert.equal(
    auditedPromotionBump.rows[0].row_version,
    operational.candidate.row_version + 1,
  )

  const planned = await warehouseServices.operations
    .planOperationsOrderFromPostgres({
      organizationId: ids.organization,
      actorEmail,
      orderGlobalId: promoted.canonicalOrderGlobalId,
      cartonizationEvidenceGlobalId: cartonizationEvidence.globalId,
      expectedRowVersion: operational.order.row_version,
      reason: 'Plan the exact Faire operational carton',
      idempotencyKey: 'commerce-staging-faire-operational-plan',
    })
  assert.equal(planned.orderStatus, 'planned')
  const released = await warehouseServices.operations
    .releaseOperationsOrderFromPostgres({
      organizationId: ids.organization,
      actorEmail,
      orderGlobalId: promoted.canonicalOrderGlobalId,
      expectedRowVersion: planned.rowVersion,
      reason: 'Release the exact Faire operational carton',
      idempotencyKey: 'commerce-staging-faire-operational-release',
    })
  assert.equal(released.orderStatus, 'released')
  const picked = await warehouseServices.operations
    .confirmOperationsOrderPicksFromPostgres({
      organizationId: ids.organization,
      actorEmail,
      orderGlobalId: promoted.canonicalOrderGlobalId,
      expectedRowVersion: released.rowVersion,
      reason: 'Confirm the exact Faire operational pick',
      idempotencyKey: 'commerce-staging-faire-operational-pick',
    })
  assert.equal(picked.orderStatus, 'picking')
  const packed = await warehouseServices.operations
    .verifyOperationsOrderPackFromPostgres({
      organizationId: ids.organization,
      actorEmail,
      orderGlobalId: promoted.canonicalOrderGlobalId,
      expectedRowVersion: picked.rowVersion,
      reason: 'Verify the exact Faire operational parcel',
      idempotencyKey: 'commerce-staging-faire-operational-pack',
    })
  assert.equal(packed.orderStatus, 'packed')
  const packageState = (await pool.query(
    `SELECT
       package.global_id, package.status,
       package.length_mm, package.width_mm, package.height_mm,
       package.weight_grams,
       carton_package.content_weight_grams,
       carton_package.tare_weight_grams,
       carton_package.rated_gross_weight_grams,
       content.quantity::text AS item_quantity,
       reservation.reservation_authority,
       pick.status AS pick_status,
       wave.status AS wave_status
     FROM operations_fulfillment_plans plan
     JOIN operations_packages package
       ON package.organization_id = plan.organization_id
      AND package.plan_id = plan.id
     JOIN operations_cartonization_rate_evidence_packages carton_package
       ON carton_package.organization_id = package.organization_id
      AND carton_package.evidence_id = package.cartonization_evidence_id
      AND carton_package.package_key = package.evidence_package_key
     JOIN operations_package_contents content
       ON content.organization_id = package.organization_id
      AND content.package_id = package.id
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = plan.organization_id
      AND allocation.plan_id = plan.id
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
     JOIN operations_pick_tasks pick
       ON pick.organization_id = allocation.organization_id
      AND pick.allocation_id = allocation.id
     JOIN operations_waves wave
       ON wave.organization_id = pick.organization_id
      AND wave.id = pick.wave_id
     WHERE plan.organization_id = $1::uuid
       AND plan.global_id = $2`,
    [ids.organization, planned.fulfillmentPlanGlobalId],
  )).rows[0]
  const packageGlobalId = packageState.global_id
  assert.deepEqual(packageState, {
    global_id: packageGlobalId,
    status: 'packed',
    length_mm: 230,
    width_mm: 180,
    height_mm: 80,
    weight_grams: 190,
    content_weight_grams: 170,
    tare_weight_grams: 20,
    rated_gross_weight_grams: 190,
    item_quantity: '1.000000',
    reservation_authority: 'local_balance',
    pick_status: 'picked',
    wave_status: 'completed',
  })

  const authorizationInput = {
    organizationId: ids.organization,
    actorEmail,
    orderGlobalId: promoted.canonicalOrderGlobalId,
    confirmationStatement:
      sandboxAuthorization.SANDBOX_COMMERCE_E2E_CONFIRMATION,
    reason: 'Authorize exact Faire sandbox E2E disposable PostgreSQL test',
    lifetimeMinutes: 30,
  }
  await assert.rejects(
    sandboxAuthorization.authorizeSandboxCommerceE2eInPostgres({
      ...authorizationInput,
      confirmationStatement: 'not the exact operator confirmation',
    }),
    (error) => error?.code === 'SANDBOX_E2E_CONFIRMATION_REQUIRED',
  )
  const authorization = await sandboxAuthorization
    .authorizeSandboxCommerceE2eInPostgres(authorizationInput)
  assert.equal(authorization.sourceProvider, 'faire')
  assert.equal(authorization.state, 'active')
  assert.equal(
    (await sandboxAuthorization.authorizeSandboxCommerceE2eInPostgres(
      authorizationInput,
    )).authorizationGlobalId,
    authorization.authorizationGlobalId,
  )
  const evidence = (await pool.query(
    `SELECT
       pack_profile_version_global_id,
       item_pack_evidence_hash,
       package_global_id,
       item_quantity::text,
       item_pack_length_mm, item_pack_width_mm, item_pack_height_mm,
       item_pack_gross_weight_grams,
       parcel_inner_dimensions_mm,
       parcel_length_mm, parcel_width_mm, parcel_height_mm,
       parcel_content_weight_grams, parcel_tare_weight_grams,
       parcel_gross_weight_grams,
       cartonization_evidence_global_id,
       cartonization_package_key,
       packaging_material_global_id,
       approved_pack_recipe_global_id,
       destination_region, destination_country_code,
       evidence_hash
     FROM operations_sandbox_commerce_e2e_faire_evidence
     WHERE organization_id = $1::uuid
       AND authorization_id = (
         SELECT id
         FROM operations_sandbox_commerce_e2e_authorizations
         WHERE organization_id = $1::uuid AND global_id = $2
       )`,
    [ids.organization, authorization.authorizationGlobalId],
  )).rows[0]
  assert.deepEqual(evidence, {
    pack_profile_version_global_id: packVersion.global_id,
    item_pack_evidence_hash: evidence.item_pack_evidence_hash,
    package_global_id: packageGlobalId,
    item_quantity: '1.000000',
    item_pack_length_mm: 203,
    item_pack_width_mm: 152,
    item_pack_height_mm: 51,
    item_pack_gross_weight_grams: 170,
    parcel_inner_dimensions_mm: { length: 220, width: 170, height: 70 },
    parcel_length_mm: 230,
    parcel_width_mm: 180,
    parcel_height_mm: 80,
    parcel_content_weight_grams: 170,
    parcel_tare_weight_grams: 20,
    parcel_gross_weight_grams: 190,
    cartonization_evidence_global_id: cartonizationEvidence.globalId,
    cartonization_package_key: recipePackage.packageKey,
    packaging_material_global_id: operational.material.global_id,
    approved_pack_recipe_global_id: operational.recipe.global_id,
    destination_region: 'CA',
    destination_country_code: 'US',
    evidence_hash: evidence.evidence_hash,
  })
  assert.match(evidence.item_pack_evidence_hash, /^[a-f0-9]{64}$/u)
  assert.match(evidence.evidence_hash, /^[a-f0-9]{64}$/u)
  await assert.rejects(
    pool.query(
      `UPDATE operations_sandbox_commerce_e2e_faire_evidence
       SET parcel_gross_weight_grams = 191
       WHERE organization_id = $1::uuid
         AND package_global_id = $2`,
      [ids.organization, packageGlobalId],
    ),
    /Faire sandbox commerce E2E evidence is immutable/,
  )

  const withAuthorizationTransaction = async (operation) => {
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
  }
  await assert.rejects(
    withAuthorizationTransaction((client) => (
      sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization(
        client,
        {
          organizationId: ids.organization,
          authorizationGlobalId: authorization.authorizationGlobalId,
          orderGlobalId: promoted.canonicalOrderGlobalId,
          actorEmail,
          packageGlobalId: 'gpa000000000000',
        },
      )
    )),
    (error) => error?.code === 'SANDBOX_E2E_FAIRE_EVIDENCE_STALE',
  )
  await assert.rejects(
    pool.query(
      `UPDATE operations_packages
       SET weight_grams = 191
       WHERE organization_id = $1::uuid AND global_id = $2`,
      [ids.organization, packageGlobalId],
    ),
    /Physical package dimensions and weight must equal sealed evidence/,
  )
  await withAuthorizationTransaction((client) => (
    sandboxAuthorization.requireActiveSandboxCommerceE2eAuthorization(
      client,
      {
        organizationId: ids.organization,
        authorizationGlobalId: authorization.authorizationGlobalId,
        orderGlobalId: promoted.canonicalOrderGlobalId,
        actorEmail,
        packageGlobalId,
      },
    )
  ))
  const consumed = await withAuthorizationTransaction((client) => (
    sandboxAuthorization.consumeSandboxCommerceE2eAuthorization(
      client,
      {
        organizationId: ids.organization,
        authorizationGlobalId: authorization.authorizationGlobalId,
        orderGlobalId: promoted.canonicalOrderGlobalId,
        actorEmail,
      },
    )
  ))
  assert.equal(consumed.state, 'consumed')
  await assert.rejects(
    withAuthorizationTransaction((client) => (
      sandboxAuthorization.consumeSandboxCommerceE2eAuthorization(
        client,
        {
          organizationId: ids.organization,
          authorizationGlobalId: authorization.authorizationGlobalId,
          orderGlobalId: promoted.canonicalOrderGlobalId,
          actorEmail,
        },
      )
    )),
    (error) => error?.code === 'SANDBOX_E2E_AUTHORIZATION_EXPIRED',
  )
  assert.deepEqual((await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_provider_attempts
        WHERE organization_id = $1::uuid) AS provider_attempts,
       (SELECT count(*)::integer
        FROM operations_labels
        WHERE organization_id = $1::uuid) AS labels,
       (SELECT count(*)::integer
        FROM operations_commerce_fulfillment_exports
        WHERE organization_id = $1::uuid) AS fulfillment_exports`,
    [ids.organization],
  )).rows[0], sideEffectsBeforeAuthorization)
}

async function verifyCustomerPrefetchBinding(
  pool,
  ids,
  persistence,
  counters,
) {
  const retailerId = 'retailer-300'
  const evidenceEmail = 'jarrett+warehouse@episcs.com'
  const customer = (await pool.query(
    `SELECT reference_code, name
     FROM crm_organizations
     WHERE id = $1::uuid`,
    [ids.customer],
  )).rows[0]
  assert.ok(customer?.reference_code)
  const runtime = {
    organizationId: ids.organization,
    integrationAccountId: ids.faireIntegrationAccount,
    globalId: 'gia0009202',
    provider: 'faire',
    credentialVersion: 1,
  }
  const durableCounts = async () => (await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_external_identifiers
        WHERE organization_id = $1::uuid
          AND integration_account_id = $2::uuid) AS identities,
       (SELECT count(*)::integer
        FROM operations_command_receipts
        WHERE organization_id = $1::uuid
          AND command_type =
              'commerce.intake.confirm_customer_prefetch_binding') AS receipts,
       (SELECT count(*)::integer
        FROM audit_events
        WHERE organization_id = $1::uuid
          AND event_type =
              'commerce.intake.customer_identity.prebound') AS audits,
       (SELECT count(*)::integer
        FROM operations_commerce_provider_attempts
        WHERE organization_id = $1::uuid) AS provider_attempts,
       (SELECT count(*)::integer
        FROM operations_commerce_intake_runs
        WHERE organization_id = $1::uuid) AS intake_runs,
       (SELECT count(*)::integer
        FROM operations_orders
        WHERE organization_id = $1::uuid) AS orders,
       (SELECT count(*)::integer
        FROM operations_fulfillment_plans
        WHERE organization_id = $1::uuid) AS fulfillment_plans,
       (SELECT count(*)::integer
        FROM operations_shipments
        WHERE organization_id = $1::uuid) AS shipments`,
    [ids.organization, ids.faireIntegrationAccount],
  )).rows[0]
  const beforePlan = await durableCounts()
  const plan = await persistence
    .planCommerceCustomerPrefetchBindingInPostgres({
      runtime,
      externalCustomerId: retailerId,
      customerGlobalId: customer.reference_code,
      evidenceEmail,
    })
  assert.equal(plan.action, 'plan-customer-binding')
  assert.equal(plan.customerGlobalId, customer.reference_code)
  assert.equal(plan.customerName, customer.name)
  assert.equal(plan.requiresConfirmation, true)
  assert.equal(plan.providerReads, 0)
  assert.equal(plan.providerWrites, 0)
  assert.equal(plan.databaseWrites, 0)
  assert.match(plan.planHash, /^[a-f0-9]{64}$/u)
  assert.match(
    plan.confirmationIdempotencyKey,
    /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  )
  assert.notEqual(plan.evidenceEmailHash, hash(evidenceEmail))
  assert.deepEqual(
    await durableCounts(),
    beforePlan,
    'Binding review must not create any durable rows',
  )
  const boundaryPlan = await persistence
    .planCommerceCustomerPrefetchBindingInPostgres({
      runtime,
      externalCustomerId: 'x'.repeat(512),
      customerGlobalId: customer.reference_code,
      evidenceEmail,
    })
  assert.equal(boundaryPlan.providerReads, 0)
  assert.equal(boundaryPlan.databaseWrites, 0)

  await pool.query(
    `UPDATE crm_organizations
     SET updated_at = updated_at + interval '1 second'
     WHERE id = $1::uuid`,
    [ids.customer],
  )
  await assert.rejects(
    persistence.confirmCommerceCustomerPrefetchBindingInPostgres({
      runtime,
      actorEmail,
      externalCustomerId: retailerId,
      customerGlobalId: customer.reference_code,
      evidenceEmail,
      planHash: plan.planHash,
      confirmed: true,
    }),
    (error) => error?.code === 'COMMERCE_CUSTOMER_PREFETCH_PLAN_STALE',
  )
  assert.deepEqual(
    await durableCounts(),
    beforePlan,
    'A stale binding plan must roll back its command receipt',
  )
  const currentPlan = await persistence
    .planCommerceCustomerPrefetchBindingInPostgres({
      runtime,
      externalCustomerId: retailerId,
      customerGlobalId: customer.reference_code,
      evidenceEmail,
    })
  const confirmed = await persistence
    .confirmCommerceCustomerPrefetchBindingInPostgres({
      runtime,
      actorEmail,
      externalCustomerId: retailerId,
      customerGlobalId: customer.reference_code,
      evidenceEmail,
      planHash: currentPlan.planHash,
      confirmed: true,
    })
  assert.equal(confirmed.bindingOutcome, 'created')
  assert.equal(confirmed.identityWrites, 1)
  assert.equal(confirmed.receiptWrites, 2)
  assert.equal(confirmed.auditWrites, 1)
  assert.equal(confirmed.databaseWrites, 4)
  assert.equal(confirmed.providerReads, 0)
  assert.equal(confirmed.providerWrites, 0)
  assert.equal(confirmed.replayed, false)
  const replay = await persistence
    .confirmCommerceCustomerPrefetchBindingInPostgres({
      runtime,
      actorEmail,
      externalCustomerId: retailerId,
      customerGlobalId: customer.reference_code,
      evidenceEmail,
      planHash: currentPlan.planHash,
      confirmed: true,
    })
  assert.equal(replay.replayed, true)

  const evidence = (await pool.query(
    `SELECT external_id.entity_global_id, external_id.external_id,
            external_id.status, external_id.match_method,
            external_id.match_evidence::text AS match_evidence,
            receipt.status AS receipt_status,
            receipt.attempts,
            receipt.idempotency_key,
            receipt.result_payload::text AS result_payload,
            audit.payload::text AS audit_payload
     FROM operations_external_identifiers external_id
     JOIN operations_command_receipts receipt
       ON receipt.organization_id = external_id.organization_id
      AND receipt.command_type =
          'commerce.intake.confirm_customer_prefetch_binding'
     JOIN audit_events audit
       ON audit.organization_id = external_id.organization_id
      AND audit.event_type =
          'commerce.intake.customer_identity.prebound'
     WHERE external_id.organization_id = $1::uuid
       AND external_id.integration_account_id = $2::uuid
       AND external_id.entity_type = 'crm.organization'
       AND external_id.external_id = $3`,
    [ids.organization, ids.faireIntegrationAccount, retailerId],
  )).rows[0]
  assert.equal(evidence.entity_global_id, customer.reference_code)
  assert.equal(evidence.external_id, retailerId)
  assert.equal(evidence.status, 'active')
  assert.equal(evidence.match_method, 'email')
  assert.equal(evidence.receipt_status, 'succeeded')
  assert.equal(evidence.attempts, 1)
  assert.equal(
    evidence.idempotency_key,
    currentPlan.confirmationIdempotencyKey,
  )
  const redactedEvidence = [
    evidence.match_evidence,
    evidence.result_payload,
    evidence.audit_payload,
  ].join('\n')
  assert.doesNotMatch(redactedEvidence, new RegExp(evidenceEmail, 'iu'))
  assert.doesNotMatch(redactedEvidence, new RegExp(retailerId, 'iu'))
  assert.match(redactedEvidence, new RegExp(currentPlan.evidenceEmailHash, 'u'))
  const afterConfirm = await durableCounts()
  assert.equal(afterConfirm.identities, beforePlan.identities + 1)
  assert.equal(afterConfirm.receipts, beforePlan.receipts + 1)
  assert.equal(afterConfirm.audits, beforePlan.audits + 1)
  for (const field of [
    'provider_attempts',
    'intake_runs',
    'orders',
    'fulfillment_plans',
    'shipments',
  ]) assert.equal(afterConfirm[field], beforePlan[field])
  assert.equal(counters.fetchCalls, 0)

  const preservedVerifiedAt = '2026-08-01T12:34:56.000Z'
  await pool.query(
    `UPDATE operations_external_identifiers
     SET last_verified_at = $4::timestamptz
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND entity_type = 'crm.organization'
       AND external_id = $3`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      retailerId,
      preservedVerifiedAt,
    ],
  )
  const operatorEvidenceBeforeAutomatic = (await pool.query(
    `SELECT entity_global_id, status, match_method, match_evidence,
            last_verified_at
     FROM operations_external_identifiers
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND entity_type = 'crm.organization'
       AND external_id = $3`,
    [ids.organization, ids.faireIntegrationAccount, retailerId],
  )).rows[0]
  assert.equal(
    operatorEvidenceBeforeAutomatic.match_evidence.evidenceType,
    'operator_confirmed_email',
  )

  const weakRetailerId = 'retailer-301'
  const weakVerifiedAt = '2026-08-01T11:00:00.000Z'
  await pool.query(
    `INSERT INTO operations_external_identifiers (
       organization_id, integration_account_id, entity_type,
       entity_global_id, external_id, status, match_method,
       match_evidence, last_verified_at
     ) VALUES (
       $1::uuid, $2::uuid, 'crm.organization', $3, $4, 'active',
       'name', '{"source":"legacy_name_match"}'::jsonb,
       $5::timestamptz
     )`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      customer.reference_code,
      weakRetailerId,
      weakVerifiedAt,
    ],
  )

  const automaticRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009205',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-binding-preservation',
    responseHash: hash('commerce-staging-faire-binding-response'),
  }
  const automaticOrder = faireRetailerOrderFixture({
    key: 'binding-preservation',
    retailerId,
    evidenceEmail,
  })
  const weakEvidenceOrder = faireRetailerOrderFixture({
    key: 'binding-normal-update',
    retailerId: weakRetailerId,
    evidenceEmail,
  })
  const automaticEnvelope = Object.freeze({
    schemaVersion: 'commerce-normalization-envelope-v1',
    normalizerVersion: 'commerce-staging-postgres-v1',
    provider: 'faire',
    organizationId: ids.organization,
    integrationAccountId: ids.faireIntegrationAccount,
    externalAccountId: 'brand-9202',
    apiVersion: '2026-07',
    observedAt,
    credentialGeneration: 1,
    retentionExpiresAt,
    sourceHash: hash('commerce-staging-faire-binding-envelope'),
    products: Object.freeze([]),
    orders: Object.freeze([automaticOrder, weakEvidenceOrder]),
    rejections: Object.freeze([]),
  })
  const automaticSeed = await pool.connect()
  try {
    await seedAdditionalCapturedRead(automaticSeed, ids, {
      ...automaticRead,
      integrationAccountId: ids.faireIntegrationAccount,
      provider: 'faire',
    })
  } finally {
    automaticSeed.release()
  }
  const stagedAutomaticOrder =
    await persistence.stageCommerceNormalizationEnvelopeInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: automaticRead.idempotencyKey,
      envelope: automaticEnvelope,
      stageAction: 'fetch',
      page: {
        mode: 'operational',
        resource: 'orders',
        sessionId: automaticRead.sessionId,
        batchNumber: 1,
        previousRunGlobalId: null,
        windowStart: null,
        windowEnd: observedAt,
        queryHash: ids.queryHash,
        nextOrderCursor: null,
        providerRowsSeen: 2,
        eligibleOrdersSeen: 2,
      },
      refreshCandidateGlobalId: null,
      retryRejectionGlobalId: null,
      readIntentId: automaticRead.readIntentId,
      capturedResponseHash: automaticRead.responseHash,
    })
  assert.equal(stagedAutomaticOrder.ordersStaged, 2)
  const automaticCandidate = (await pool.query(
    `SELECT global_id, row_version::integer
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      automaticOrder.identity.value,
    ],
  )).rows[0]
  assert.ok(automaticCandidate?.global_id)
  const automaticResolution =
    await persistence.resolveCommerceCandidateCustomerInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: 'commerce-staging-faire-external-id-resolution',
      candidateGlobalId: automaticCandidate.global_id,
      candidateRowVersion: automaticCandidate.row_version,
      customer: {
        mode: 'existing',
        customerGlobalId: customer.reference_code,
        resolutionMethod: 'external_id',
      },
    })
  assert.equal(
    automaticResolution.customerResolutionMethod,
    'external_id',
  )
  const operatorEvidenceAfterAutomatic = (await pool.query(
    `SELECT identity.entity_global_id, identity.status,
            identity.match_method, identity.match_evidence,
            identity.last_verified_at,
            candidate.customer_match_method,
            customer.reference_code AS candidate_customer_global_id
     FROM operations_external_identifiers identity
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = identity.organization_id
      AND candidate.integration_account_id = identity.integration_account_id
      AND candidate.global_id = $4
     JOIN crm_organizations customer
       ON customer.pipeline_id = candidate.pipeline_id
      AND customer.id = candidate.customer_id
     WHERE identity.organization_id = $1::uuid
       AND identity.integration_account_id = $2::uuid
       AND identity.entity_type = 'crm.organization'
       AND identity.external_id = $3`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      retailerId,
      automaticCandidate.global_id,
    ],
  )).rows[0]
  assert.equal(
    operatorEvidenceAfterAutomatic.entity_global_id,
    customer.reference_code,
  )
  assert.equal(operatorEvidenceAfterAutomatic.status, 'active')
  assert.equal(operatorEvidenceAfterAutomatic.match_method, 'email')
  assert.deepEqual(
    operatorEvidenceAfterAutomatic.match_evidence,
    operatorEvidenceBeforeAutomatic.match_evidence,
    'Automatic same-entity resolution must preserve stronger operator evidence',
  )
  assert.equal(
    new Date(operatorEvidenceAfterAutomatic.last_verified_at).toISOString(),
    preservedVerifiedAt,
    'Automatic same-entity resolution must preserve its verified timestamp',
  )
  assert.equal(
    operatorEvidenceAfterAutomatic.customer_match_method,
    'external_id',
  )
  assert.equal(
    operatorEvidenceAfterAutomatic.candidate_customer_global_id,
    customer.reference_code,
  )
  const weakEvidenceCandidate = (await pool.query(
    `SELECT global_id, row_version::integer, source_hash
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      weakEvidenceOrder.identity.value,
    ],
  )).rows[0]
  assert.ok(weakEvidenceCandidate?.global_id)
  await persistence.resolveCommerceCandidateCustomerInPostgres({
    runtime,
    actorEmail,
    idempotencyKey: 'commerce-staging-faire-normal-binding-evidence',
    candidateGlobalId: weakEvidenceCandidate.global_id,
    candidateRowVersion: weakEvidenceCandidate.row_version,
    customer: {
      mode: 'existing',
      customerGlobalId: customer.reference_code,
      resolutionMethod: 'external_id',
    },
  })
  const normalAutomaticEvidence = (await pool.query(
    `SELECT entity_global_id, status, match_method, match_evidence,
            last_verified_at
     FROM operations_external_identifiers
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND entity_type = 'crm.organization'
       AND external_id = $3`,
    [ids.organization, ids.faireIntegrationAccount, weakRetailerId],
  )).rows[0]
  assert.equal(normalAutomaticEvidence.entity_global_id, customer.reference_code)
  assert.equal(normalAutomaticEvidence.status, 'active')
  assert.equal(normalAutomaticEvidence.match_method, 'external_id')
  assert.deepEqual(normalAutomaticEvidence.match_evidence, {
    candidateGlobalId: weakEvidenceCandidate.global_id,
    sourceHash: weakEvidenceCandidate.source_hash,
  })
  assert.ok(
    new Date(normalAutomaticEvidence.last_verified_at).getTime()
      > new Date(weakVerifiedAt).getTime(),
    'Normal automatic evidence should verify when no stronger binding exists',
  )

  const conflictingCustomer = (await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, identity_key, name, relationship_type,
       email, source_payload, source_hash, sync_status, created_by, updated_by
     ) VALUES (
       $1::uuid, 'commerce-prefetch-conflict-customer',
       'customer:commerce-prefetch-conflict-customer',
       'Conflicting customer', 'customer', 'other@example.com', '{}'::jsonb,
       $2, 'synced', $3, $3
     ) RETURNING reference_code`,
    [ids.pipeline, hash('prefetch-conflict-customer'), actorEmail],
  )).rows[0]
  const candidateBeforeConflict = (await pool.query(
    `SELECT row_version::integer, customer_id::text
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND global_id = $2`,
    [ids.organization, automaticCandidate.global_id],
  )).rows[0]
  await assert.rejects(
    persistence.resolveCommerceCandidateCustomerInPostgres({
      runtime,
      actorEmail,
      idempotencyKey: 'commerce-staging-faire-binding-conflict',
      candidateGlobalId: automaticCandidate.global_id,
      candidateRowVersion: candidateBeforeConflict.row_version,
      customer: {
        mode: 'existing',
        customerGlobalId: conflictingCustomer.reference_code,
        resolutionMethod: 'external_id',
      },
    }),
    (error) => error?.code === 'COMMERCE_INTAKE_CUSTOMER_IDENTITY_CONFLICT',
  )
  const conflictRollback = (await pool.query(
    `SELECT identity.entity_global_id, identity.match_method,
            identity.match_evidence, identity.last_verified_at,
            candidate.row_version::integer,
            candidate.customer_id::text
     FROM operations_external_identifiers identity
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = identity.organization_id
      AND candidate.integration_account_id = identity.integration_account_id
      AND candidate.global_id = $4
     WHERE identity.organization_id = $1::uuid
       AND identity.integration_account_id = $2::uuid
       AND identity.entity_type = 'crm.organization'
       AND identity.external_id = $3`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      retailerId,
      automaticCandidate.global_id,
    ],
  )).rows[0]
  assert.equal(conflictRollback.entity_global_id, customer.reference_code)
  assert.equal(conflictRollback.match_method, 'email')
  assert.deepEqual(
    conflictRollback.match_evidence,
    operatorEvidenceBeforeAutomatic.match_evidence,
  )
  assert.equal(
    new Date(conflictRollback.last_verified_at).toISOString(),
    preservedVerifiedAt,
  )
  assert.equal(
    conflictRollback.row_version,
    candidateBeforeConflict.row_version,
  )
  assert.equal(
    conflictRollback.customer_id,
    candidateBeforeConflict.customer_id,
  )
  await pool.query(
    `INSERT INTO operations_external_identifiers (
       organization_id, integration_account_id, entity_type,
       entity_global_id, external_id, status, match_method, match_evidence
     ) VALUES (
       $1::uuid, $2::uuid, 'crm.organization', $3, 'retailer-conflict',
       'active', 'external_id', '{}'::jsonb
     )`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      conflictingCustomer.reference_code,
    ],
  )
  await assert.rejects(
    persistence.planCommerceCustomerPrefetchBindingInPostgres({
      runtime,
      externalCustomerId: 'retailer-conflict',
      customerGlobalId: customer.reference_code,
      evidenceEmail,
    }),
    (error) => error?.code === 'COMMERCE_CUSTOMER_PREFETCH_IDENTITY_CONFLICT',
  )
  await pool.query(
    `UPDATE crm_organizations
     SET email = $2
     WHERE pipeline_id = $1::uuid
       AND reference_code = $3`,
    [ids.pipeline, evidenceEmail, conflictingCustomer.reference_code],
  )
  await assert.rejects(
    persistence.planCommerceCustomerPrefetchBindingInPostgres({
      runtime,
      externalCustomerId: 'retailer-ambiguous',
      customerGlobalId: customer.reference_code,
      evidenceEmail,
    }),
    (error) => error?.code === 'COMMERCE_CUSTOMER_PREFETCH_EMAIL_AMBIGUOUS',
  )
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
  assert.match(promotion.canonicalOrderGlobalId, /^gor[0-9a-v]{12}$/)
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

async function verifyShopifyAttentionAcrossWorkerScans(input) {
  const {
    pool,
    ids,
    missingCandidate,
    historicalCandidate,
    canonicalOrderGlobalId,
    intakePersistence,
    runtime,
    runGlobalId,
    cohortHash,
  } = input
  const persistence = loadCommerceOrderReconciliationPersistence(pool)
  const readHistoricalCandidate = async () => (await pool.query(
    `SELECT
       candidate.workflow_state,
       candidate.last_error_code,
       candidate.expires_at > now() AS unexpired,
       (SELECT count(*)::integer
        FROM operations_orders canonical
        WHERE canonical.organization_id = candidate.organization_id
          AND canonical.integration_account_id =
              candidate.integration_account_id
          AND canonical.external_order_id = candidate.external_order_id)
         AS canonical_count
     FROM operations_commerce_order_candidates candidate
     WHERE candidate.organization_id = $1::uuid
       AND candidate.global_id = $2`,
    [ids.organization, historicalCandidate.global_id],
  )).rows[0]
  assert.deepEqual(
    await readHistoricalCandidate(),
    {
      workflow_state: 'ready',
      last_error_code: null,
      unexpired: true,
      canonical_count: 0,
    },
    'A pre-feature unresolved candidate must remain explicitly unmarked',
  )
  const scans = [
    {
      providerRowsSeen: 1,
      ordersStaged: 1,
      held: 1,
      actionableHeld: 1,
      heldByReason: { checkout_rate_lineage_missing: 1 },
    },
    {
      providerRowsSeen: 0,
      ordersStaged: 0,
      held: 0,
      actionableHeld: 0,
      heldByReason: {},
    },
    {
      providerRowsSeen: 0,
      ordersStaged: 0,
      held: 0,
      actionableHeld: 0,
      heldByReason: {},
    },
    {
      providerRowsSeen: 0,
      ordersStaged: 0,
      held: 0,
      actionableHeld: 0,
      heldByReason: {},
    },
  ]
  const worker = loadCommerceOrderReconciliationWorker({
    persistence,
    async executeCommerceOrderPage() {
      const scan = scans.shift()
      assert.ok(scan, 'Unexpected extra Shopify reconciliation worker page')
      return {
        command: {
          providerWrites: 0,
          syncCursorAdvanced: false,
          canonicalOrdersCreated: 0,
          inventoryTouched: 0,
          ordersStaged: scan.ordersStaged,
          recordsRejected: 0,
          pagination: {
            runGlobalId: 'gcir0099999',
            providerRowsSeen: scan.providerRowsSeen,
            batchNumber: 1,
            hasNextBatch: false,
            continuationRunGlobalId: null,
          },
          automaticCustomerResolution: {
            matched: 0,
            created: 0,
            ambiguous: 0,
            skipped: 0,
            failed: 0,
            failedByCode: {},
            providerWrites: 0,
            syncCursorAdvanced: false,
          },
          automaticShopifyOrderPromotion: {
            promoted: 0,
            held: scan.held,
            actionableHeld: scan.actionableHeld,
            heldByReason: scan.heldByReason,
            failed: 0,
            failedByCode: {},
            rollbackFenced: 0,
            providerWrites: 0,
            canonicalOrderWrites: 0,
            inventoryWrites: 0,
            syncCursorAdvanced: false,
          },
          automaticFaireOrderPromotion: {
            promoted: 0,
            held: 0,
            failed: 0,
            failedByCode: {},
            providerWrites: 0,
            canonicalOrderWrites: 0,
            inventoryWrites: 0,
            syncCursorAdvanced: false,
          },
        },
      }
    },
  })
  const faireStatus = (await pool.query(
    `SELECT status
     FROM operations_integration_accounts
     WHERE organization_id = $1::uuid
       AND id = $2::uuid`,
    [ids.organization, ids.faireIntegrationAccount],
  )).rows[0]?.status || null
  if (faireStatus) {
    await pool.query(
      `UPDATE operations_integration_accounts
       SET status = 'error', updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [ids.organization, ids.faireIntegrationAccount],
    )
  }
  const makeRootPollDue = async (clearError = false) => {
    await pool.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'succeeded',
           last_error_code = CASE WHEN $3 THEN NULL ELSE last_error_code END,
           last_started_at = now() - interval '31 minutes',
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'`,
      [ids.organization, ids.integrationAccount, clearError],
    )
  }
  try {
    await makeRootPollDue(true)
    const actionable = await worker.processCommerceOrderReconciliation({
      limit: 1,
    })
    assert.equal(actionable.claimed, 1)
    assert.equal(
      actionable.automaticShopifyOrderPromotion.actionableHeld,
      1,
    )
    assert.equal(
      actionable.automaticShopifyOrderPromotion.attentionRequiredAccounts,
      1,
    )
    assert.equal(
      actionable.automaticShopifyOrderPromotion.operatorReviewRequired,
      1,
    )
    let health = await persistence
      .readCommerceOrderReconciliationHealthFromPostgres()
    assert.equal(
      health.providerPromotionAttentionRequired.shopify,
      1,
    )

    await makeRootPollDue()
    const laterEmptyPoll = await worker.processCommerceOrderReconciliation({
      limit: 1,
    })
    assert.equal(laterEmptyPoll.claimed, 1)
    assert.equal(
      laterEmptyPoll.automaticShopifyOrderPromotion.actionableHeld,
      0,
    )
    assert.equal(
      laterEmptyPoll.automaticShopifyOrderPromotion.attentionRequiredAccounts,
      1,
      'An empty root poll must retain account attention for an unresolved candidate',
    )
    assert.equal(
      laterEmptyPoll.automaticShopifyOrderPromotion.operatorReviewRequired,
      1,
    )
    health = await persistence.readCommerceOrderReconciliationHealthFromPostgres()
    assert.equal(
      health.providerPromotionAttentionRequired.shopify,
      1,
      'The durable health signal must survive an empty root poll',
    )
    const retainedState = await persistence
      .readCommerceOrderReconciliationStateInPostgres({
        organizationId: ids.organization,
        accountGlobalId: 'gia0009201',
      })
    assert.equal(retainedState.automaticPromotionAttentionRequired, true)

    const resolutionClient = await pool.connect()
    try {
      await resolutionClient.query('SET session_replication_role = replica')
      await resolutionClient.query(
        `UPDATE operations_commerce_order_candidates candidate
         SET workflow_state = 'failed',
             last_error_code = 'operator_resolved',
             blocking_codes = ARRAY['operator_resolved']::text[],
             row_version = candidate.row_version + 1,
             updated_by = $4,
             updated_at = now()
         FROM operations_commerce_intake_runs run
         WHERE candidate.organization_id = $1::uuid
           AND candidate.integration_account_id = $2::uuid
           AND candidate.global_id = $3
           AND run.organization_id = candidate.organization_id
           AND run.integration_account_id = candidate.integration_account_id
           AND run.id = candidate.run_id
           AND run.created_by = 'system:commerce-order-reconciliation'
           AND candidate.provider = 'shopify'
           AND candidate.workflow_state IN ('held', 'resolving', 'ready')`,
        [
          ids.organization,
          ids.integrationAccount,
          missingCandidate.global_id,
          actorEmail,
        ],
      )
    } finally {
      await resolutionClient.query('SET session_replication_role = origin')
        .catch(() => {})
      resolutionClient.release()
    }
    await makeRootPollDue()
    const resolvedPoll = await worker.processCommerceOrderReconciliation({
      limit: 1,
    })
    assert.equal(resolvedPoll.claimed, 1)
    assert.equal(
      resolvedPoll.automaticShopifyOrderPromotion.attentionRequiredAccounts,
      0,
    )
    assert.equal(
      resolvedPoll.automaticShopifyOrderPromotion.operatorReviewRequired,
      0,
    )
    health = await persistence.readCommerceOrderReconciliationHealthFromPostgres()
    assert.equal(health.providerPromotionAttentionRequired.shopify, 0)
    assert.deepEqual(
      await readHistoricalCandidate(),
      {
        workflow_state: 'ready',
        last_error_code: null,
        unexpired: true,
        canonical_count: 0,
      },
      'An unresolved historical NULL-marker candidate must not keep account attention active',
    )

    const staleContinuationLease = (await pool.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'running',
           last_error_code =
             'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED',
           last_started_at = date_trunc('milliseconds', clock_timestamp()),
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'
       RETURNING last_started_at`,
      [ids.organization, ids.integrationAccount],
    )).rows[0]
    const emptyContinuation = await persistence
      .completeCommerceOrderReconciliationInPostgres({
        target: {
          organizationId: ids.organization,
          integrationAccountId: ids.integrationAccount,
          accountGlobalId: 'gia0009201',
          provider: 'shopify',
          credentialVersion: 1,
          startedAt: staleContinuationLease.last_started_at.toISOString(),
          recordsSeen: 0,
          recordsHeld: 0,
          continuationBatchNumber: 2,
          continuationRunGlobalId: 'gcir0099999',
          continuationIdempotencyKey: null,
        },
        providerRecordsSeen: 0,
        ordersHeld: 0,
        recordsRejected: 0,
        pagesRead: 1,
        hasNextBatch: false,
        customersMatched: 0,
        customersCreated: 0,
        customersAmbiguous: 0,
        customersSkipped: 0,
        customerResolutionFailed: 0,
        customerResolutionFailureCodes: {},
        shopifyOrdersPromoted: 0,
        shopifyOrdersHeld: 0,
        shopifyPromotionActionableHeld: 0,
        shopifyPromotionHeldReasons: {},
        shopifyPromotionFailed: 0,
        shopifyPromotionFailureCodes: {},
        shopifyPromotionRollbackFenced: 0,
        faireOrdersPromoted: 0,
        faireOrdersHeld: 0,
        fairePromotionFailed: 0,
        fairePromotionFailureCodes: {},
      })
    assert.equal(emptyContinuation.leaseLost, false)
    assert.equal(
      emptyContinuation.shopifyAutomaticPromotionAttentionRequired,
      false,
      'An empty continuation must not preserve stale Shopify attention without an active marked candidate',
    )
    const clearedContinuation = (await pool.query(
      `SELECT reconciliation_status, last_error_code
       FROM operations_commerce_sync_cursors
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'`,
      [ids.organization, ids.integrationAccount],
    )).rows[0]
    assert.deepEqual(clearedContinuation, {
      reconciliation_status: 'succeeded',
      last_error_code: null,
    })

    let dedupeCandidateRowVersion = 0
    const dedupeClient = await pool.connect()
    try {
      await dedupeClient.query('SET session_replication_role = replica')
      await dedupeClient.query(
        `UPDATE operations_orders
         SET external_order_id = $3, updated_at = now()
         WHERE organization_id = $1::uuid
           AND global_id = $2`,
        [
          ids.organization,
          canonicalOrderGlobalId,
          missingCandidate.external_order_id,
        ],
      )
      const reopenedCandidate = await dedupeClient.query(
        `UPDATE operations_commerce_order_candidates
         SET workflow_state = 'held',
             last_error_code = NULL,
             blocking_codes = '{}'::text[],
             expires_at = now() + interval '7 days',
             row_version = row_version + 1,
             updated_by = $3,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND global_id = $2
         RETURNING row_version::integer`,
        [ids.organization, missingCandidate.global_id, actorEmail],
      )
      dedupeCandidateRowVersion =
        reopenedCandidate.rows[0]?.row_version || 0
    } finally {
      await dedupeClient.query('SET session_replication_role = origin')
        .catch(() => {})
      dedupeClient.release()
    }
    assert.ok(dedupeCandidateRowVersion > 0)
    const canonicalRace = await intakePersistence
      .markAutomaticShopifyOrderPromotionAttentionInPostgres({
        runtime,
        actorEmail: 'system:commerce-order-reconciliation',
        idempotencyKey: 'shopify-auto-attention-canonical-race',
        candidateGlobalId: missingCandidate.global_id,
        candidateRowVersion: dedupeCandidateRowVersion,
        runGlobalId,
        reasonCode: 'checkout_rate_lineage_missing',
        expectedCohortHash: cohortHash,
      })
    assert.equal(canonicalRace.marked, false)
    assert.equal(canonicalRace.reasonCode, 'canonical_order_exists')
    assert.equal(canonicalRace.rowVersion, dedupeCandidateRowVersion)
    const canonicalRaceMarker = (await pool.query(
      `SELECT last_error_code
       FROM operations_commerce_order_candidates
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [ids.organization, missingCandidate.global_id],
    )).rows[0]
    assert.equal(canonicalRaceMarker.last_error_code, null)
    await makeRootPollDue()
    const benignDedupePoll = await worker.processCommerceOrderReconciliation({
      limit: 1,
    })
    assert.equal(benignDedupePoll.claimed, 1)
    assert.equal(
      benignDedupePoll.automaticShopifyOrderPromotion.attentionRequiredAccounts,
      0,
      'A held candidate with an existing canonical order is a benign dedupe',
    )
    health = await persistence.readCommerceOrderReconciliationHealthFromPostgres()
    assert.equal(health.providerPromotionAttentionRequired.shopify, 0)
    assert.equal(scans.length, 0)
  } finally {
    if (faireStatus) {
      await pool.query(
        `UPDATE operations_integration_accounts
         SET status = $3, updated_at = now()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [ids.organization, ids.faireIntegrationAccount, faireStatus],
      )
    }
  }
}

async function verifyAutomaticShopifyCleanPromotion(
  pool,
  ids,
  counters,
) {
  const helperAcl = (await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_proc function_row
       CROSS JOIN LATERAL aclexplode(
         COALESCE(
           function_row.proacl,
           acldefault('f', function_row.proowner)
         )
       ) privilege
       WHERE function_row.oid = (
         'public.operations_shopify_checkout_rate_match_candidate_facts_for_workflow(uuid,uuid,boolean,boolean)'
       )::regprocedure
         AND privilege.grantee = 0
         AND privilege.privilege_type = 'EXECUTE'
     ) AS public_execute`)).rows[0]
  assert.equal(
    helperAcl.public_execute,
    false,
    'The Boolean Shopify checkout workflow helper must not be executable by PUBLIC',
  )
  const candidateKeys = {
    success: 'gid://shopify/Order/mapped-fractional',
    missing: 'gid://shopify/Order/mismatch-positive',
    ambiguous: 'gid://shopify/Order/negative-positive',
    expired: 'gid://shopify/Order/fulfilled-missing',
  }
  const sourceTimestamp = new Date().toISOString()
  const requestedDeliveryAt = new Date(
    Date.now() + 2 * 24 * 60 * 60 * 1_000,
  ).toISOString()
  const address = {
    name: 'Shopify clean-path acceptance',
    line1: '123 Test Street',
    city: 'Atlanta',
    region: 'GA',
    postalCode: '30301',
    country: 'US',
  }
  const addressCiphertext = Buffer.from(JSON.stringify(address), 'utf8')

  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES ('system:commerce-order-reconciliation', 'owner', 'active')
     ON CONFLICT (email) DO NOTHING`,
  )

  await pool.query(
    `UPDATE operations_integration_accounts
     SET environment = 'sandbox', status = 'active', updated_at = now()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid`,
    [ids.organization, ids.integrationAccount],
  )
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Shop/9201',
       'shopify_client_credentials', $3, $4, $5, 1, '9201',
       'verified', now(), 'unverified', $6, $6
     ) ON CONFLICT (organization_id, integration_account_id) DO UPDATE SET
       verification_status = 'verified',
       verified_at = now(),
       last_error_code = NULL,
       credential_version = 1,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [
      ids.organization,
      ids.integrationAccount,
      Buffer.from('shopify-clean-path-test-credential'),
      Buffer.alloc(12, 3),
      Buffer.alloc(16, 4),
      actorEmail,
    ],
  )
  const profileVersion = (await pool.query(
    `SELECT
       version.id::text,
       version.row_version::integer,
       profile.package_level,
       version.base_each_quantity,
       version.length_mm,
       version.width_mm,
       version.height_mm,
       version.gross_weight_grams
     FROM operations_product_pack_profile_versions version
     JOIN operations_product_pack_profiles profile
       ON profile.organization_id = version.organization_id
      AND profile.pipeline_id = version.pipeline_id
      AND profile.product_id = version.product_id
      AND profile.id = version.profile_id
     WHERE version.organization_id = $1::uuid
       AND version.pipeline_id = $2::uuid
       AND version.product_id = $3::uuid
       AND version.is_current = true
       AND version.lifecycle_state IN ('customer_confirmed', 'active')
       AND profile.status <> 'retired'
       AND version.dimension_basis = 'outer'
       AND version.gross_weight_grams IS NOT NULL
     ORDER BY profile.is_default DESC, version.created_at DESC
     LIMIT 1`,
    [ids.organization, ids.pipeline, ids.product],
  )).rows[0]
  assert.ok(profileVersion?.id, 'A current exact pack profile is required')

  let channelState = (await pool.query(
    `SELECT id::text, pack_evidence_hash
     FROM operations_product_channel_states
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_variant_id = $3`,
    [ids.organization, ids.integrationAccount, ids.mappedVariant],
  )).rows[0]
  if (!channelState) {
    channelState = (await pool.query(
      `INSERT INTO operations_product_channel_states (
         organization_id, integration_account_id, pipeline_id, provider,
         external_product_id, external_variant_id, product_id,
         product_mapping_id, provider_status_raw, normalized_status,
         provider_active, provider_updated_at, observed_at, source_revision,
         source_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify',
         'gid://shopify/Product/mapped-zero', $4, $5::uuid, $6::uuid,
         'ACTIVE', 'active', true, now(), now(), $7, $8, $9, $9
       ) RETURNING id::text, pack_evidence_hash`,
      [
        ids.organization,
        ids.integrationAccount,
        ids.pipeline,
        ids.mappedVariant,
        ids.product,
        ids.productMapping,
        sourceTimestamp,
        hash('shopify-clean-path-channel-state'),
        actorEmail,
      ],
    )).rows[0]
  }
  let packMapping = (await pool.query(
    `SELECT id::text, row_version::integer, pack_evidence_hash
     FROM operations_commerce_variant_pack_mappings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider = 'shopify'
       AND external_variant_id = $3
       AND is_current = true`,
    [ids.organization, ids.integrationAccount, ids.mappedVariant],
  )).rows[0]
  if (!packMapping) {
    packMapping = (await pool.query(
      `INSERT INTO operations_commerce_variant_pack_mappings (
         organization_id, integration_account_id, pipeline_id, product_id,
         provider, external_product_id, external_variant_id,
         default_pack_profile_version_id, provider_lifecycle_state,
         projection_state, source_revision, source_hash, provider_updated_at,
         observed_at, is_current, pack_evidence_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify',
         'gid://shopify/Product/mapped-zero', $5, $6::uuid, 'active',
         'current', $7, $8, now(), now(), true, $9, $10, $10
       ) RETURNING id::text, row_version::integer, pack_evidence_hash`,
      [
        ids.organization,
        ids.integrationAccount,
        ids.pipeline,
        ids.product,
        ids.mappedVariant,
        profileVersion.id,
        sourceTimestamp,
        hash('shopify-clean-path-pack-mapping'),
        channelState.pack_evidence_hash,
        actorEmail,
      ],
    )).rows[0]
  }
  assert.equal(packMapping.pack_evidence_hash, channelState.pack_evidence_hash)

  const setup = await pool.connect()
  try {
    await setup.query('SET session_replication_role = replica')
    await setup.query(
      `UPDATE operations_commerce_intake_runs run
       SET created_by = 'system:commerce-order-reconciliation',
           updated_by = 'system:commerce-order-reconciliation',
           expires_at = now() + interval '7 days'
       FROM operations_commerce_order_candidates candidate
       WHERE candidate.run_id = run.id
         AND candidate.organization_id = $1::uuid
         AND candidate.external_order_id = ANY($2::text[])`,
      [ids.organization, Object.values(candidateKeys)],
    )
    const updatedCandidates = await setup.query(
      `UPDATE operations_commerce_order_candidates candidate
       SET normalized_order_status = 'open',
           normalized_payment_status = 'paid',
           normalized_fulfillment_status = 'unfulfilled',
           normalized_return_status = 'none',
           requires_shipping = true,
           currency_code = 'USD',
           subtotal_minor = 0,
           discount_minor = 0,
           brand_discount_minor = 0,
           shipping_minor = CASE
             WHEN candidate.external_order_id = $10 THEN 0
             ELSE 2071
           END,
           tax_minor = 0,
           other_adjustment_minor = 0,
           total_minor = CASE
             WHEN candidate.external_order_id = $10 THEN 0
             ELSE 2071
           END,
           header_money_state = 'complete',
           header_money_gaps = '{}'::text[],
           customer_resolution_state = 'resolved',
           customer_match_method = 'external_id',
           customer_id = $3::uuid,
           ship_to_snapshot_state = 'confirmed',
           ship_to_snapshot_source = 'provider',
           ship_to_snapshot_ciphertext = $4,
           ship_to_snapshot_iv = $5,
           ship_to_snapshot_tag = $6,
           ship_to_snapshot_hash = $7,
           ship_to_snapshot_encryption_version = 1,
           delivery_resolution_state = 'policy',
           requested_delivery_at = $8::timestamptz,
           delivery_policy_version = 'shopify-clean-path-test-v1',
           provider_created_at = $9::timestamptz,
           provider_updated_at = $9::timestamptz,
           observed_at = $9::timestamptz,
           source_revision = candidate.external_order_id || ':clean-v1',
           source_hash = encode(
             digest(candidate.external_order_id || ':clean-v1', 'sha256'),
             'hex'
           ),
           checkout_destination_fingerprint = encode(
             digest(candidate.external_order_id || ':destination', 'sha256'),
             'hex'
           ),
           checkout_shipping_service_code = 'clawpilot:ups:ground',
           workflow_state = 'ready',
           last_error_code = NULL,
           blocking_codes = '{}'::text[],
           row_version = candidate.row_version + 1,
           updated_by = 'system:commerce-order-reconciliation',
           updated_at = now(),
           expires_at = now() + interval '7 days'
       WHERE candidate.organization_id = $1::uuid
         AND candidate.external_order_id = ANY($2::text[])
       RETURNING candidate.id::text, candidate.global_id,
                 candidate.external_order_id,
                 candidate.run_id::text, candidate.row_version::integer`,
      [
        ids.organization,
        Object.values(candidateKeys),
        ids.customer,
        addressCiphertext,
        Buffer.alloc(12, 5),
        Buffer.alloc(16, 6),
        hash(addressCiphertext),
        requestedDeliveryAt,
        sourceTimestamp,
        candidateKeys.success,
      ],
    )
    assert.equal(updatedCandidates.rowCount, 4)
    const updatedLines = await setup.query(
      `UPDATE operations_commerce_order_candidate_lines line
       SET external_product_id = 'gid://shopify/Product/mapped-zero',
           external_variant_id = $3,
           sku_snapshot = 'POSTGRES-MAPPED',
           provider_status_raw = 'OPEN',
           normalized_status = 'open',
           ordered_quantity = 1,
           current_quantity = 1,
           cancelled_quantity = 0,
           fulfilled_quantity = 0,
           unfulfilled_quantity = 1,
           returned_quantity = 0,
           unit_multiplier = 1,
           physical_quantity = 1,
           currency_code = 'USD',
           unit_price_minor = 0,
           subtotal_minor = 0,
           discount_minor = 0,
           brand_discount_minor = 0,
           tax_minor = 0,
           other_adjustment_minor = 0,
           total_minor = 0,
           price_resolution_state = 'provider',
           resolved_currency_code = 'USD',
           resolved_unit_price_minor = 0,
           resolved_subtotal_minor = 0,
           resolved_discount_minor = 0,
           resolved_brand_discount_minor = 0,
           resolved_tax_minor = 0,
           resolved_other_adjustment_minor = 0,
           resolved_total_minor = 0,
           requires_shipping = true,
           mapping_state = 'resolved',
           product_id = $4::uuid,
           product_mapping_id = $5::uuid,
           packaging_state = 'resolved',
           package_profile_id = NULL,
           packaging_source = 'variant_pack_mapping',
           commerce_variant_pack_mapping_id = $6::uuid,
           commerce_variant_pack_mapping_row_version = $7::bigint,
           pack_profile_version_id = $8::uuid,
           pack_profile_version_row_version = $9::bigint,
           pack_profile_package_level = $10,
           pack_profile_base_each_quantity = $11::integer,
           packaging_weight_source = 'profile_version',
           weight_grams = $12::integer,
           length_mm = $13::integer,
           width_mm = $14::integer,
           height_mm = $15::integer,
           observed_at = $16::timestamptz,
           source_revision = line.external_line_id || ':clean-v1',
           source_hash = encode(
             digest(line.external_line_id || ':clean-v1', 'sha256'), 'hex'
           ),
           workflow_state = 'ready',
           blocking_codes = '{}'::text[],
           row_version = line.row_version + 1,
           updated_by = 'system:commerce-order-reconciliation',
           updated_at = now(),
           expires_at = now() + interval '7 days'
       FROM operations_commerce_order_candidates candidate
       WHERE line.organization_id = $1::uuid
         AND candidate.organization_id = line.organization_id
         AND candidate.id = line.order_candidate_id
         AND candidate.external_order_id = ANY($2::text[])
       RETURNING line.id::text`,
      [
        ids.organization,
        Object.values(candidateKeys),
        ids.mappedVariant,
        ids.product,
        ids.productMapping,
        packMapping.id,
        packMapping.row_version,
        profileVersion.id,
        profileVersion.row_version,
        profileVersion.package_level,
        profileVersion.base_each_quantity,
        profileVersion.gross_weight_grams,
        profileVersion.length_mm,
        profileVersion.width_mm,
        profileVersion.height_mm,
        sourceTimestamp,
      ],
    )
    assert.equal(updatedLines.rowCount, 4)
  } finally {
    await setup.query('SET session_replication_role = origin').catch(() => {})
    setup.release()
  }

  const candidates = (await pool.query(
    `SELECT
       candidate.id::text,
       candidate.global_id,
       candidate.external_order_id,
       candidate.row_version::integer,
       candidate.provider_created_at,
       candidate.observed_at,
       candidate.checkout_destination_fingerprint,
       run.global_id AS run_global_id,
       operations_shopify_checkout_order_line_quantity_fingerprint(
         candidate.organization_id, candidate.id
       ) AS line_quantity_fingerprint
     FROM operations_commerce_order_candidates candidate
     JOIN operations_commerce_intake_runs run
       ON run.id = candidate.run_id
     WHERE candidate.organization_id = $1::uuid
       AND candidate.external_order_id = ANY($2::text[])`,
    [ids.organization, Object.values(candidateKeys)],
  )).rows
  const byExternalId = new Map(candidates.map((row) => [
    row.external_order_id,
    row,
  ]))
  const runGlobalId = candidates[0].run_global_id
  assert.ok(candidates.every((candidate) => (
    candidate.run_global_id === runGlobalId
  )))

  async function insertCheckoutReceipt(input) {
    const candidate = input.candidate
    const providerCreatedAt = new Date(candidate.provider_created_at).getTime()
    const createdAt = new Date(
      providerCreatedAt - (input.expired ? 3 * 60 * 60_000 : 60_000),
    )
    const windowSeconds = input.expired ? 60 : 7_200
    const completedAt = new Date(createdAt.getTime() + 5_000)
    const expiresAt = new Date(completedAt.getTime() + 24 * 60 * 60_000)
    const fakeConfigId = randomUUID()
    const fakeWarehouseId = randomUUID()
    const fakeCarrierAccountId = randomUUID()
    const fakeCarrierRateRequestId = randomUUID()
    const fakeCarrierNetworkId = randomUUID()
    const fakeCarrierAuthorizationId = randomUUID()
    const packagePlanHash = hash(`clean-package:${input.key}`)
    const carrierCostMinor = 2071
    const customerChargeMinor = input.subsidized ? 0 : carrierCostMinor
    const checkoutAdjustmentMinor = input.subsidized
      ? -carrierCostMinor
      : 0
    const checkoutAdjustmentKind = input.subsidized ? 'subsidy' : 'none'
    const client = await pool.connect()
    try {
      await client.query('SET session_replication_role = replica')
      await client.query(
        `INSERT INTO operations_carrier_accounts (
           id, organization_id, integration_account_id, display_name,
           sender_name,
           account_number_ciphertext, account_number_iv, account_number_tag,
           encryption_version, account_number_last_four,
           account_number_fingerprint, registered_address,
           registered_address_fingerprint, address_verification, status,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, 'ClawPilot Test',
           'test-ciphertext', 'test-iv',
           'test-tag', 1, '9999', $5, $6::jsonb, $7,
           'operator_attested', 'active',
           'system:commerce-order-reconciliation',
           'system:commerce-order-reconciliation'
         )`,
        [
          fakeCarrierAccountId,
          ids.organization,
          ids.integrationAccount,
          `Shopify clean path ${input.key}`,
          hash(`clean-account:${input.key}`),
          JSON.stringify({
            line1: '123 Test Street',
            city: 'Atlanta',
            region: 'GA',
            postalCode: '30301',
            countryCode: 'US',
          }),
          hash(`clean-account-address:${input.key}`),
        ],
      )
      await client.query(
        `INSERT INTO operations_carrier_rate_requests (
           id, organization_id, integration_account_id, provider,
           carrier_account_id, network_id, account_authorization_id,
           billing_relationship, billing_selection_snapshot,
           environment, purpose, adapter_version, credential_version,
           request_hash, redacted_request, redacted_response, status,
           actor_email, requested_at, completed_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'ups_rest', $4::uuid, $5::uuid,
           $6::uuid, 'sender', '{}'::jsonb, 'sandbox',
           'cartonization_shipment_rate', 'shopify-clean-path-test-v1', 1,
           $7, '{}'::jsonb, '{}'::jsonb, 'succeeded',
           'system:commerce-order-reconciliation',
           $8::timestamptz, $9::timestamptz
         )`,
        [
          fakeCarrierRateRequestId,
          ids.organization,
          ids.integrationAccount,
          fakeCarrierAccountId,
          fakeCarrierNetworkId,
          fakeCarrierAuthorizationId,
          hash(`clean-rate-request:${input.key}`),
          createdAt.toISOString(),
          completedAt.toISOString(),
        ],
      )
      const receipt = (await client.query(
        `INSERT INTO operations_shopify_checkout_rate_receipts (
           global_id, organization_id, integration_account_id, config_id,
           config_row_version, credential_generation, activation_revision,
           activation_state, policy_revision, policy_hash, warehouse_id,
           algorithm_version, request_fingerprint, destination_fingerprint,
           carrier_destination_fingerprint, line_quantity_fingerprint,
           request_evidence_hash, redacted_request_snapshot, currency,
           idempotency_key, status, line_count, package_count, offer_count,
           package_plan_hash, result_hash, result_snapshot,
           provider_write_count, inventory_snapshot_hash,
           inventory_snapshot_at, reconciliation_window_seconds,
           reconciliation_deadline_at, expires_at, completed_at,
           created_at, updated_at
         ) VALUES (
           $1, $2::uuid, $3::uuid, $4::uuid, 0, 1, 1, 'shadow', 1, $5,
           $6::uuid, 'shopify-clean-path-test-v1', $7, $8, $9, $10, $11,
           '{}'::jsonb, 'USD', $12, 'succeeded', 1, 1, 1, $13, $14,
           '{}'::jsonb, 0, $15, $16::timestamptz, $17::integer,
           $18::timestamptz, $19::timestamptz, $20::timestamptz,
           $21::timestamptz, $21::timestamptz
         ) RETURNING id::text`,
        [
          input.globalId,
          ids.organization,
          ids.integrationAccount,
          fakeConfigId,
          hash(`clean-policy:${input.key}`),
          fakeWarehouseId,
          hash(`clean-request:${input.key}`),
          candidate.checkout_destination_fingerprint,
          hash(`clean-carrier-destination:${input.key}`),
          candidate.line_quantity_fingerprint,
          hash(`clean-request-evidence:${input.key}`),
          `shopify-clean-path-${input.key}`,
          packagePlanHash,
          hash(`clean-result:${input.key}`),
          hash(`clean-inventory:${input.key}`),
          createdAt.toISOString(),
          windowSeconds,
          new Date(
            createdAt.getTime() + windowSeconds * 1_000,
          ).toISOString(),
          expiresAt.toISOString(),
          completedAt.toISOString(),
          createdAt.toISOString(),
        ],
      )).rows[0]
      await client.query(
        `INSERT INTO operations_shopify_checkout_rate_receipt_offers (
           organization_id, receipt_id, carrier_provider,
           carrier_account_id, carrier_rate_request_id, carrier_request_hash,
           carrier_response_rate_hash, shopify_service_code, service_code,
           service_name, carrier_cost_minor, customer_charge_minor,
           checkout_adjustment_minor, checkout_adjustment_kind, currency,
           package_count, package_plan_hash, offer_hash, offer_snapshot
         ) VALUES (
           $1::uuid, $2::uuid, 'ups_rest', $3::uuid, $4::uuid, $5, $6,
           'clawpilot:ups:ground', 'ground', 'UPS Ground', $7::bigint,
           $8::bigint, $9::bigint, $10, 'USD', 1, $11, $12, '{}'::jsonb
         )`,
        [
          ids.organization,
          receipt.id,
          fakeCarrierAccountId,
          fakeCarrierRateRequestId,
          hash(`clean-carrier-request:${input.key}`),
          hash(`clean-carrier-response:${input.key}`),
          carrierCostMinor,
          customerChargeMinor,
          checkoutAdjustmentMinor,
          checkoutAdjustmentKind,
          packagePlanHash,
          hash(`clean-offer:${input.key}`),
        ],
      )
    } finally {
      await client.query('SET session_replication_role = origin').catch(() => {})
      client.release()
    }
  }

  const successCandidate = byExternalId.get(candidateKeys.success)
  const missingCandidate = byExternalId.get(candidateKeys.missing)
  const ambiguousCandidate = byExternalId.get(candidateKeys.ambiguous)
  const expiredCandidate = byExternalId.get(candidateKeys.expired)
  await insertCheckoutReceipt({
    candidate: successCandidate,
    key: 'success-a',
    globalId: 'gsqr0099901',
    subsidized: true,
  })
  await insertCheckoutReceipt({
    candidate: ambiguousCandidate,
    key: 'ambiguous-a',
    globalId: 'gsqr0099902',
  })
  await insertCheckoutReceipt({
    candidate: expiredCandidate,
    key: 'expired-a',
    globalId: 'gsqr0099903',
    expired: true,
  })
  const subsidizedCheckout = (await pool.query(
    `SELECT
       candidate.shipping_minor::text AS candidate_shipping_minor,
       offer.carrier_cost_minor::text AS carrier_cost_minor,
       offer.customer_charge_minor::text AS customer_charge_minor,
       offer.checkout_adjustment_minor::text AS checkout_adjustment_minor,
       offer.checkout_adjustment_kind,
       (
         SELECT count(*)::integer
         FROM operations_shopify_checkout_rate_preflight_match_candidates(
           candidate.organization_id, candidate.id, true
         )
       ) AS preflight_match_count
     FROM operations_commerce_order_candidates candidate
     JOIN operations_shopify_checkout_rate_receipts receipt
       ON receipt.organization_id = candidate.organization_id
      AND receipt.global_id = 'gsqr0099901'
     JOIN operations_shopify_checkout_rate_receipt_offers offer
       ON offer.organization_id = receipt.organization_id
      AND offer.receipt_id = receipt.id
     WHERE candidate.organization_id = $1::uuid
       AND candidate.global_id = $2`,
    [ids.organization, successCandidate.global_id],
  )).rows[0]
  assert.deepEqual(subsidizedCheckout, {
    candidate_shipping_minor: '0',
    carrier_cost_minor: '2071',
    customer_charge_minor: '0',
    checkout_adjustment_minor: '-2071',
    checkout_adjustment_kind: 'subsidy',
    preflight_match_count: 1,
  })

  const previousClawPilotEnv = process.env.CLAWPILOT_ENV
  const previousCohort = process.env
    .CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS
  process.env.CLAWPILOT_ENV = 'development'
  process.env.CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS =
    'gia0009201'
  try {
    const shopifyCheckoutRating = loadShopifyCheckoutRatingPersistence(pool)
    const persistence = loadCommerceStagingService(pool, counters, {
      shopifyCheckoutRating,
    })
    const promotionPolicy = loadTypeScriptModule(
      'app_src/lib/integrations/commerceShopifyAutomaticPromotion.ts',
    )
    const gate = promotionPolicy.shopifyAutomaticOrderPromotionGate({
      accountGlobalId: 'gia0009201',
    })
    assert.equal(gate.accountEnabled, true)
    assert.match(gate.cohortHash, /^[a-f0-9]{64}$/u)
    const runtime = {
      organizationId: ids.organization,
      integrationAccountId: ids.integrationAccount,
      globalId: 'gia0009201',
      provider: 'shopify',
      environment: 'sandbox',
      externalAccountId: 'gid://shopify/Shop/9201',
      status: 'active',
      verificationStatus: 'verified',
      credentialVersion: 1,
      authMode: 'shopify_client_credentials',
      configuration: { shopDomain: 'commerce-staging-postgres.myshopify.com' },
      encrypted: {},
    }
    const targets = await persistence
      .readAutomaticShopifyOrderPromotionTargetsForRunInPostgres({
        runtime,
        runGlobalId,
        expectedCohortHash: gate.cohortHash,
      })
    const targetByCandidate = new Map(targets.map((target) => [
      target.candidateGlobalId,
      target,
    ]))
    assert.equal(
      targetByCandidate.get(successCandidate.global_id)?.eligible,
      true,
      JSON.stringify(targetByCandidate.get(successCandidate.global_id)),
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        targetByCandidate.get(missingCandidate.global_id),
      )),
      {
        eligible: false,
        reason: 'checkout_rate_lineage_missing',
        candidateGlobalId: missingCandidate.global_id,
        candidateRowVersion: missingCandidate.row_version,
        providerAddress: null,
        deliveryMode: null,
      },
    )
    assert.equal(
      targetByCandidate.get(ambiguousCandidate.global_id)?.eligible,
      true,
    )
    assert.equal(
      targetByCandidate.get(expiredCandidate.global_id)?.reason,
      'checkout_rate_lineage_expired',
    )

    await assert.rejects(
      persistence.markAutomaticShopifyOrderPromotionAttentionInPostgres({
        runtime,
        actorEmail: 'system:commerce-order-reconciliation',
        idempotencyKey: 'shopify-auto-attention-benign-veto',
        candidateGlobalId: expiredCandidate.global_id,
        candidateRowVersion: expiredCandidate.row_version,
        runGlobalId,
        reasonCode: 'canonical_order_exists',
        expectedCohortHash: gate.cohortHash,
      }),
      (error) => error?.code
        === 'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_ATTENTION_NOT_REQUIRED',
    )

    const attentionInput = {
      runtime,
      actorEmail: 'system:commerce-order-reconciliation',
      idempotencyKey: 'shopify-auto-attention-missing',
      candidateGlobalId: missingCandidate.global_id,
      candidateRowVersion: missingCandidate.row_version,
      runGlobalId,
      reasonCode: 'checkout_rate_lineage_missing',
      expectedCohortHash: gate.cohortHash,
    }
    const markedAttention = await persistence
      .markAutomaticShopifyOrderPromotionAttentionInPostgres(attentionInput)
    assert.equal(markedAttention.marked, true)
    assert.equal(markedAttention.alreadyMarked, false)
    assert.equal(markedAttention.replayed, false)
    assert.equal(markedAttention.providerWrites, 0)
    assert.equal(markedAttention.inventoryWrites, 0)
    assert.equal(markedAttention.syncCursorAdvanced, false)
    const replayedAttention = await persistence
      .markAutomaticShopifyOrderPromotionAttentionInPostgres(attentionInput)
    assert.equal(replayedAttention.replayed, true)
    const attentionEvidence = (await pool.query(
      `SELECT
         candidate.last_error_code,
         candidate.row_version::integer,
         (SELECT count(*)::integer
          FROM operations_command_receipts receipt
          WHERE receipt.organization_id = candidate.organization_id
            AND receipt.command_type =
                'commerce.intake.mark_shopify_auto_promotion_attention'
            AND receipt.idempotency_key = $3) AS receipt_count,
         (SELECT count(*)::integer
          FROM audit_events event
          WHERE event.organization_id = candidate.organization_id
            AND event.aggregate_id = candidate.global_id
            AND event.event_type =
                'commerce.intake.shopify_auto_promotion.attention_marked')
           AS audit_count
       FROM operations_commerce_order_candidates candidate
       WHERE candidate.organization_id = $1::uuid
         AND candidate.global_id = $2`,
      [
        ids.organization,
        missingCandidate.global_id,
        attentionInput.idempotencyKey,
      ],
    )).rows[0]
    assert.deepEqual(attentionEvidence, {
      last_error_code:
        promotionPolicy.SHOPIFY_AUTOMATIC_ORDER_PROMOTION_ATTENTION_MARKER,
      row_version: missingCandidate.row_version + 1,
      receipt_count: 1,
      audit_count: 1,
    })

    const promotionInput = {
      runtime,
      actorEmail: 'system:commerce-order-reconciliation',
      idempotencyKey: 'shopify-clean-path-success',
      candidateGlobalId: successCandidate.global_id,
      candidateRowVersion: successCandidate.row_version,
      requestHash: hash('shopify-clean-path-success'),
      automaticShopifyPromotion: {
        policyVersion:
          promotionPolicy.SHOPIFY_AUTOMATIC_ORDER_PROMOTION_POLICY_VERSION,
        cohortHash: gate.cohortHash,
      },
    }
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET verification_status = 'failed',
           last_error_code = 'TEST_CREDENTIAL_DRIFT',
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integrationAccount],
    )
    await assert.rejects(
      persistence.promoteCommerceCandidateInPostgres(promotionInput),
      (error) => error?.code
        === 'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_CREDENTIAL_STALE',
    )
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET verification_status = 'verified',
           verified_at = now(),
           last_error_code = NULL,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integrationAccount],
    )
    const sourceDrift = await pool.connect()
    try {
      await sourceDrift.query('SET session_replication_role = replica')
      await sourceDrift.query(
        `UPDATE operations_commerce_order_candidates
         SET provider_created_at = now() - interval '49 hours',
             observed_at = now() - interval '49 hours'
         WHERE organization_id = $1::uuid
           AND global_id = $2`,
        [ids.organization, successCandidate.global_id],
      )
    } finally {
      await sourceDrift.query('SET session_replication_role = origin')
        .catch(() => {})
      sourceDrift.release()
    }
    await assert.rejects(
      persistence.promoteCommerceCandidateInPostgres(promotionInput),
      (error) => error?.code
        === 'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_INVARIANT_STALE',
    )
    const sourceRestore = await pool.connect()
    try {
      await sourceRestore.query('SET session_replication_role = replica')
      await sourceRestore.query(
        `UPDATE operations_commerce_order_candidates
         SET provider_created_at = $3::timestamptz,
             observed_at = $4::timestamptz
         WHERE organization_id = $1::uuid
           AND global_id = $2`,
        [
          ids.organization,
          successCandidate.global_id,
          successCandidate.provider_created_at,
          successCandidate.observed_at,
        ],
      )
    } finally {
      await sourceRestore.query('SET session_replication_role = origin')
        .catch(() => {})
      sourceRestore.release()
    }
    const providerAttemptsBefore = Number((await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid`,
      [ids.organization],
    )).rows[0].count)
    const promoted = await persistence
      .promoteCommerceCandidateInPostgres(promotionInput)
    assert.equal(promoted.replayed, false)
    assert.equal(promoted.checkoutRateReconciliation.outcome, 'matched')
    assert.equal(promoted.providerWrites, 0)
    assert.equal(promoted.inventoryWrites, 0)
    const authoritativeSubsidizedMatch = (await pool.query(
      `SELECT
         reconciliation.outcome,
         reconciliation.source_shipping_charge_minor::text
           AS source_shipping_charge_minor,
         reconciliation.selected_customer_charge_minor::text
           AS selected_customer_charge_minor,
         offer.carrier_cost_minor::text AS carrier_cost_minor,
         offer.checkout_adjustment_minor::text AS checkout_adjustment_minor,
         offer.checkout_adjustment_kind
       FROM operations_shopify_checkout_rate_reconciliations reconciliation
       JOIN operations_shopify_checkout_rate_receipt_offers offer
         ON offer.organization_id = reconciliation.organization_id
        AND offer.receipt_id = reconciliation.receipt_id
        AND offer.offer_hash = reconciliation.selected_offer_hash
       WHERE reconciliation.organization_id = $1::uuid
         AND reconciliation.order_candidate_id = $2::uuid`,
      [ids.organization, successCandidate.id],
    )).rows[0]
    assert.deepEqual(authoritativeSubsidizedMatch, {
      outcome: 'matched',
      source_shipping_charge_minor: '0',
      selected_customer_charge_minor: '0',
      carrier_cost_minor: '2071',
      checkout_adjustment_minor: '-2071',
      checkout_adjustment_kind: 'subsidy',
    })
    const replayed = await persistence
      .promoteCommerceCandidateInPostgres(promotionInput)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.canonicalOrderGlobalId,
      promoted.canonicalOrderGlobalId)
    assert.equal(Number((await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_commerce_provider_attempts
       WHERE organization_id = $1::uuid`,
      [ids.organization],
    )).rows[0].count), providerAttemptsBefore)

    await insertCheckoutReceipt({
      candidate: ambiguousCandidate,
      key: 'ambiguous-b',
      globalId: 'gsqr0099904',
    })
    const ambiguousInput = {
      ...promotionInput,
      idempotencyKey: 'shopify-clean-path-ambiguous-race',
      candidateGlobalId: ambiguousCandidate.global_id,
      candidateRowVersion: ambiguousCandidate.row_version,
      requestHash: hash('shopify-clean-path-ambiguous-race'),
    }
    await assert.rejects(
      persistence.promoteCommerceCandidateInPostgres(ambiguousInput),
      (error) => error?.code
        === 'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED',
    )
    const rollback = (await pool.query(
      `SELECT
         candidate.workflow_state,
         candidate.canonical_order_id::text,
         (SELECT count(*)::integer
          FROM operations_orders operation_order
          WHERE operation_order.organization_id = candidate.organization_id
            AND operation_order.external_order_id = candidate.external_order_id)
           AS canonical_count,
         (SELECT count(*)::integer
          FROM operations_shopify_checkout_rate_reconciliations reconciliation
          WHERE reconciliation.organization_id = candidate.organization_id
            AND reconciliation.order_candidate_id = candidate.id)
           AS reconciliation_count,
         (SELECT count(*)::integer
          FROM operations_command_receipts receipt
          WHERE receipt.organization_id = candidate.organization_id
            AND receipt.idempotency_key =
                'shopify-clean-path-ambiguous-race') AS command_receipt_count
       FROM operations_commerce_order_candidates candidate
       WHERE candidate.organization_id = $1::uuid
         AND candidate.global_id = $2`,
      [ids.organization, ambiguousCandidate.global_id],
    )).rows[0]
    assert.deepEqual(rollback, {
      workflow_state: 'ready',
      canonical_order_id: null,
      canonical_count: 0,
      reconciliation_count: 0,
      command_receipt_count: 0,
    })
    const ambiguousTargets = await persistence
      .readAutomaticShopifyOrderPromotionTargetsForRunInPostgres({
        runtime,
        runGlobalId,
        expectedCohortHash: gate.cohortHash,
      })
    assert.equal(
      ambiguousTargets.find((target) => (
        target.candidateGlobalId === ambiguousCandidate.global_id
      ))?.reason,
      'checkout_rate_lineage_ambiguous',
    )
    const heldCanonicalCount = Number((await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND external_order_id = ANY($2::text[])`,
      [
        ids.organization,
        [candidateKeys.missing, candidateKeys.expired, candidateKeys.ambiguous],
      ],
    )).rows[0].count)
    assert.equal(heldCanonicalCount, 0)
    await verifyShopifyAttentionAcrossWorkerScans({
      pool,
      ids,
      missingCandidate,
      historicalCandidate: expiredCandidate,
      canonicalOrderGlobalId: promoted.canonicalOrderGlobalId,
      intakePersistence: persistence,
      runtime,
      runGlobalId,
      cohortHash: gate.cohortHash,
    })
  } finally {
    if (previousClawPilotEnv === undefined) {
      delete process.env.CLAWPILOT_ENV
    } else {
      process.env.CLAWPILOT_ENV = previousClawPilotEnv
    }
    if (previousCohort === undefined) {
      delete process.env
        .CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS
    } else {
      process.env.CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS =
        previousCohort
    }
  }
}

async function verifyAutomaticFaireExactRefreshLineage(
  pool,
  ids,
  persistence,
  counters,
) {
  const systemActor = 'system:commerce-order-reconciliation'
  const runtime = {
    organizationId: ids.organization,
    integrationAccountId: ids.faireIntegrationAccount,
    globalId: 'gia0009202',
    provider: 'faire',
    credentialVersion: 1,
  }
  const promotionNotBefore = String(
    process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE || '',
  )
  const promotionCohortHash = createHash('sha256')
    .update('commerce-faire-order-auto-promotion-v1')
    .update('\0')
    .update(runtime.globalId)
    .update('\0')
    .update(promotionNotBefore)
    .digest('hex')
  const key = 'auto_exact_lineage'
  const externalOrderId = `faire-order-${key}`
  const externalProductId = `p_${key}`
  const externalVariantId = `po_${key}`
  const sku = `POSTGRES-${key}`
  const freshObservedAt = new Date().toISOString()
  const freshRetentionExpiresAt = new Date(
    Date.now() + 20 * 24 * 60 * 60 * 1_000,
  ).toISOString()
  const orderIdentityLockKey = (externalOrderId) => [
    'commerce-intake-order-identity-v1',
    ids.organization,
    ids.faireIntegrationAccount,
    externalOrderId,
  ].join(':')
  const waitForAdvisoryWait = async (label) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const waiting = (await pool.query(
        `SELECT count(*)::integer AS count
         FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND lower(COALESCE(wait_event, '')) = 'advisory'
           AND query LIKE '%pg_advisory_xact_lock%'`,
      )).rows[0].count
      if (waiting > 0) return
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    assert.fail(`${label} did not wait on the shared order identity lock`)
  }
  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES ($1, 'owner', 'active')
     ON CONFLICT (email) DO NOTHING`,
    [systemActor],
  )
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'brand-9202', 'faire_brand_token',
       $3, $4, $5, 1, '9202', 'verified', now(), 'not_applicable', $6, $6
     ) ON CONFLICT (organization_id, integration_account_id) DO UPDATE SET
       auth_mode = 'faire_brand_token',
       credential_version = 1,
       verification_status = 'verified',
       verified_at = now(),
       last_error_code = NULL,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      Buffer.from('faire-auto-promotion-test-credential'),
      Buffer.alloc(12, 9),
      Buffer.alloc(16, 10),
      actorEmail,
    ],
  )
  const reconciliationPersistence =
    loadCommerceOrderReconciliationPersistence(pool)
  const completeFaireAttentionScan = async ({
    promotionReviewRequired = 0,
    exactRefreshReviewRequired = 0,
    failureCode = null,
  } = {}) => {
    const shopifyStatus = (await pool.query(
      `SELECT status
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [ids.organization, ids.integrationAccount],
    )).rows[0]?.status || null
    try {
      if (shopifyStatus) {
        await pool.query(
          `UPDATE operations_integration_accounts
           SET status = 'error', updated_at = now()
           WHERE organization_id = $1::uuid
             AND id = $2::uuid`,
          [ids.organization, ids.integrationAccount],
        )
      }
      await pool.query(
        `UPDATE operations_commerce_sync_cursors
         SET reconciliation_status = 'succeeded',
             last_started_at = now() - interval '31 minutes',
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND resource = 'orders'`,
        [ids.organization, ids.faireIntegrationAccount],
      )
      const claimed = await reconciliationPersistence
        .claimCommerceOrderReconciliationTargetsInPostgres({ limit: 1 })
      assert.equal(claimed.length, 1)
      assert.equal(claimed[0].provider, 'faire')
      if (failureCode) {
        const failed = await reconciliationPersistence
          .failCommerceOrderReconciliationInPostgres({
            target: claimed[0],
            error: { code: failureCode },
          })
        assert.equal(failed.leaseLost, false)
        const health = await reconciliationPersistence
          .readCommerceOrderReconciliationHealthFromPostgres()
        const state = await reconciliationPersistence
          .readCommerceOrderReconciliationStateInPostgres({
            organizationId: ids.organization,
            accountGlobalId: runtime.globalId,
          })
        return { failed, health, state }
      }
      const completed = await reconciliationPersistence
        .completeCommerceOrderReconciliationInPostgres({
          target: claimed[0],
          providerRecordsSeen: 0,
          ordersHeld: 0,
          recordsRejected: 0,
          pagesRead: 1,
          hasNextBatch: false,
          customersMatched: 0,
          customersCreated: 0,
          customersAmbiguous: 0,
          customersSkipped: 0,
          customerResolutionFailed: 0,
          customerResolutionFailureCodes: {},
          shopifyOrdersPromoted: 0,
          shopifyOrdersHeld: 0,
          shopifyPromotionActionableHeld: 0,
          shopifyPromotionHeldReasons: {},
          shopifyPromotionFailed: 0,
          shopifyPromotionFailureCodes: {},
          shopifyPromotionRollbackFenced: 0,
          faireOrdersPromoted: 0,
          faireOrdersHeld: 0,
          fairePromotionFailed: 0,
          fairePromotionFailureCodes: {},
          fairePromotionOperatorReviewRequired: promotionReviewRequired,
          faireExactRefreshAttempted: 0,
          faireExactRefreshSucceeded: 0,
          faireExactRefreshRejected: 0,
          faireExactRefreshFailed: 0,
          faireExactRefreshOperatorReviewRequired:
            exactRefreshReviewRequired,
          faireExactRefreshFailureCodes: {},
        })
      assert.equal(completed.leaseLost, false)
      const health = await reconciliationPersistence
        .readCommerceOrderReconciliationHealthFromPostgres()
      const state = await reconciliationPersistence
        .readCommerceOrderReconciliationStateInPostgres({
          organizationId: ids.organization,
          accountGlobalId: runtime.globalId,
        })
      return { completed, health, state }
    } finally {
      if (shopifyStatus) {
        await pool.query(
          `UPDATE operations_integration_accounts
           SET status = $3, updated_at = now()
           WHERE organization_id = $1::uuid
             AND id = $2::uuid`,
          [ids.organization, ids.integrationAccount, shopifyStatus],
        )
      }
    }
  }
  const customerGlobalId = (await pool.query(
    `SELECT reference_code
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid
       AND id = $2::uuid`,
    [ids.pipeline, ids.customer],
  )).rows[0].reference_code
  const mapping = (await pool.query(
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
      ids.organization,
      ids.faireIntegrationAccount,
      ids.pipeline,
      ids.product,
      sku,
      externalProductId,
      externalVariantId,
      hash('faire-auto-exact-lineage-mapping'),
      systemActor,
    ],
  )).rows[0]
  assert.ok(mapping.id)

  const baseOrder = faireRetailerOrderFixture({
    key,
    retailerId: 'retailer-auto-exact-lineage',
    evidenceEmail: 'jarrett+warehouse@episcs.com',
  })
  const incompleteMoney = {
    shipping: unavailable(),
    total: unavailable(),
    headerMoney: Object.freeze({
      state: 'operational_incomplete',
      unavailableFields: Object.freeze(['shipping', 'total']),
      fulfillmentDemandEligible: true,
      accountingEligible: false,
      customerChargeEligible: false,
    }),
  }
  const exactOrder = Object.freeze({
    ...baseOrder,
    ...incompleteMoney,
    providerCreatedAt: freshObservedAt,
    providerProcessedAt: freshObservedAt,
    providerUpdatedAt: freshObservedAt,
    sourceStale: false,
    sourceHash: hash('faire-auto-exact-current-order'),
  })
  const listOrder = Object.freeze({
    ...exactOrder,
    sourceStale: true,
    readinessFacts: Object.freeze([
      ...exactOrder.readinessFacts,
      Object.freeze({
        dimension: 'source',
        code: 'source_stale',
        blocking: true,
        subjectExternalId: externalOrderId,
      }),
    ]),
    sourceHash: hash('faire-auto-exact-stale-list-order'),
  })

  const seedWorkerRead = async (input) => {
    const readActor = input.actorEmail || systemActor
    const seeded = await pool.connect()
    try {
      await seedAdditionalCapturedRead(seeded, ids, {
        providerAttemptId: input.providerAttemptId,
        providerAttemptGlobalId: input.providerAttemptGlobalId,
        readIntentId: input.readIntentId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        responseHash: input.responseHash,
        integrationAccountId: ids.faireIntegrationAccount,
        provider: 'faire',
        resource: 'orders',
        // Seed through a schema-valid root read, then atomically move the
        // intent to its final schema-valid refresh/candidate identity below.
        intakeAction: 'fetch',
      })
      await seeded.query('SET session_replication_role = replica')
      await seeded.query(
        `UPDATE operations_commerce_provider_attempts
         SET created_by = $2
         WHERE id = $1::uuid`,
        [input.providerAttemptId, readActor],
      )
      await seeded.query(
        `UPDATE operations_commerce_intake_read_intents
         SET created_by = $2,
             updated_by = $2,
             target_kind = $3,
             target_global_id = $4,
             target_source_hash = $5,
             target_external_id_hash = $6,
             window_end = $7::timestamptz,
             intake_action = $8
         WHERE id = $1::uuid`,
        [
          input.readIntentId,
          readActor,
          input.targetCandidate ? 'candidate' : 'none',
          input.targetCandidate?.globalId || null,
          input.targetCandidate?.sourceHash || null,
          input.targetCandidate
            ? commandHash(input.externalOrderId || externalOrderId)
            : null,
          freshObservedAt,
          input.intakeAction,
        ],
      )
    } finally {
      await seeded.query('SET session_replication_role = origin').catch(() => {})
      seeded.release()
    }
  }

  const stageWorkerEnvelope = async (input) => {
    counters.expectedImageStage = {
      idempotencyKey: input.read.idempotencyKey,
      readIntentId: input.read.readIntentId,
    }
    return persistence.stageCommerceNormalizationEnvelopeInPostgres({
      runtime,
      actorEmail: input.read.actorEmail || systemActor,
      idempotencyKey: input.read.idempotencyKey,
      envelope: Object.freeze({
        schemaVersion: 'commerce-normalization-envelope-v1',
        normalizerVersion: 'commerce-staging-postgres-v1',
        provider: 'faire',
        organizationId: ids.organization,
        integrationAccountId: ids.faireIntegrationAccount,
        externalAccountId: 'brand-9202',
        apiVersion: '2026-07',
        observedAt: freshObservedAt,
        credentialGeneration: 1,
        retentionExpiresAt: freshRetentionExpiresAt,
        sourceHash: hash(`${input.read.idempotencyKey}:envelope`),
        products: Object.freeze([]),
        orders: Object.freeze(input.orders || [input.order]),
        rejections: Object.freeze(input.rejections || []),
      }),
      stageAction: input.action,
      page: input.action === 'refresh'
        ? null
        : {
            mode: 'operational',
            resource: 'orders',
            sessionId: input.read.sessionId,
            batchNumber: 1,
            previousRunGlobalId: null,
            windowStart: null,
            windowEnd: freshObservedAt,
            queryHash: ids.queryHash,
            nextOrderCursor: null,
            providerRowsSeen: (input.orders || [input.order]).length
              + (input.rejections || []).length,
            eligibleOrdersSeen: (input.orders || [input.order]).length,
          },
      refreshCandidateGlobalId:
        input.targetCandidate?.globalId || null,
      retryRejectionGlobalId: null,
      readIntentId: input.read.readIntentId,
      capturedResponseHash: input.read.responseHash,
    })
  }

  const listRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009240',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-list',
    responseHash: hash('commerce-staging-faire-auto-list-response'),
    intakeAction: 'fetch',
    targetCandidate: null,
  }
  await seedWorkerRead(listRead)
  const listStage = await stageWorkerEnvelope({
    read: listRead,
    action: 'fetch',
    order: listOrder,
    targetCandidate: null,
  })
  assert.equal(listStage.ordersStaged, 1)
  const staleCandidate = (await pool.query(
    `SELECT global_id, row_version::integer, source_hash,
            header_money_state, header_money_gaps
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [ids.organization, ids.faireIntegrationAccount, externalOrderId],
  )).rows[0]
  assert.equal(staleCandidate.source_hash, listOrder.sourceHash)
  assert.equal(staleCandidate.header_money_state, 'operational_incomplete')
  assert.deepEqual(staleCandidate.header_money_gaps, ['shipping', 'total'])

  const preFeatureKey = '22_prefeature_rediscovered'
  const preFeatureExternalOrderId = `faire-order-${preFeatureKey}`
  const preFeatureBaseOrder = faireRetailerOrderFixture({
    key: preFeatureKey,
    retailerId: 'retailer-22-prefeature',
    evidenceEmail: 'jarrett+22-prefeature@episcs.com',
  })
  const preFeatureOrder = Object.freeze({
    ...preFeatureBaseOrder,
    providerCreatedAt: new Date(
      Date.parse(promotionNotBefore) - 1,
    ).toISOString(),
    providerProcessedAt: freshObservedAt,
    providerUpdatedAt: freshObservedAt,
    sourceStale: true,
    readinessFacts: Object.freeze([
      ...preFeatureBaseOrder.readinessFacts,
      Object.freeze({
        dimension: 'source',
        code: 'source_stale',
        blocking: true,
        subjectExternalId: preFeatureExternalOrderId,
      }),
    ]),
    sourceHash: hash('faire-auto-22-prefeature-rediscovered'),
  })
  const preFeatureRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009239',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-22-prefeature',
    responseHash: hash('commerce-staging-faire-auto-22-response'),
    intakeAction: 'fetch',
    targetCandidate: null,
  }
  await seedWorkerRead(preFeatureRead)
  const preFeatureStage = await stageWorkerEnvelope({
    read: preFeatureRead,
    action: 'fetch',
    order: preFeatureOrder,
    targetCandidate: null,
  })
  const preFeatureCandidate = (await pool.query(
    `SELECT global_id, provider_created_at, observed_at
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      preFeatureExternalOrderId,
    ],
  )).rows[0]
  assert.ok(
    new Date(preFeatureCandidate.provider_created_at).getTime()
      < Date.parse(promotionNotBefore),
  )
  assert.ok(
    new Date(preFeatureCandidate.observed_at).getTime()
      >= Date.parse(promotionNotBefore),
    'The pre-feature provider order is deliberately rediscovered after rollout',
  )
  assert.equal((await persistence
    .readAutomaticFaireExactRefreshTargetsInPostgres({
      runtime,
      preferredRunGlobalId: preFeatureStage.runGlobalId,
      limit: 10,
    })).some(
      (target) => target.candidateGlobalId === preFeatureCandidate.global_id,
    ), false, 'A 22-like provider order created before rollout must never enter unattended exact refresh even when rediscovered afterward')
  assert.equal((await persistence
    .readAutomaticFaireOrderPromotionTargetsForRunInPostgres({
      runtime,
      runGlobalId: preFeatureStage.runGlobalId,
    })).length, 0, 'A post-cutoff observation cannot make a pre-cutoff provider order automatically promotable')

  const refreshTargets = await persistence
    .readAutomaticFaireExactRefreshTargetsInPostgres({
      runtime,
      preferredRunGlobalId: listStage.runGlobalId,
      limit: 10,
    })
  assert.deepEqual(
    JSON.parse(JSON.stringify(refreshTargets)),
    [{
      candidateGlobalId: staleCandidate.global_id,
      candidateRowVersion: staleCandidate.row_version,
      sourceHash: staleCandidate.source_hash,
      originatingRunGlobalId: listStage.runGlobalId,
      cohortHash: promotionCohortHash,
      notBefore: promotionNotBefore,
    }],
  )
  assert.equal((await persistence
    .readAutomaticFaireExactRefreshTargetsInPostgres({
      runtime,
      preferredRunGlobalId: listStage.runGlobalId,
      limit: 10,
      excludedCandidateGlobalIds: [staleCandidate.global_id],
    })).length, 0, 'An invocation must not reselect an exact target it already attempted')
  const stalePromotionTargets = await persistence
    .readAutomaticFaireOrderPromotionTargetsForRunInPostgres({
      runtime,
      runGlobalId: listStage.runGlobalId,
    })
  assert.equal(stalePromotionTargets[0].eligible, false)
  assert.equal(stalePromotionTargets[0].reason, 'exact_refresh_required')
  await assert.rejects(
    persistence.readCommerceIntakeRefreshTargetFromPostgres({
      organizationId: ids.organization,
      accountGlobalId: runtime.globalId,
      candidateGlobalId: staleCandidate.global_id,
      expectedSourceHash: '0'.repeat(64),
      expectedRowVersion: staleCandidate.row_version,
    }),
    (error) => error?.code === 'COMMERCE_INTAKE_REFRESH_TARGET_CHANGED',
  )

  const exactRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009241',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-exact',
    responseHash: hash('commerce-staging-faire-auto-exact-response'),
    intakeAction: 'refresh',
    targetCandidate: {
      globalId: staleCandidate.global_id,
      sourceHash: staleCandidate.source_hash,
    },
  }
  await seedWorkerRead(exactRead)
  const exactStage = await stageWorkerEnvelope({
    read: exactRead,
    action: 'refresh',
    order: exactOrder,
    targetCandidate: exactRead.targetCandidate,
  })
  assert.equal(exactStage.ordersStaged, 1)
  const exactReplay = await stageWorkerEnvelope({
    read: exactRead,
    action: 'refresh',
    order: exactOrder,
    targetCandidate: exactRead.targetCandidate,
  })
  assert.equal(exactReplay.replayed, true)
  assert.equal(exactReplay.runGlobalId, exactStage.runGlobalId)
  const crashRecoveryTargets = await persistence
    .readAutomaticFaireExactRefreshTargetsInPostgres({
      runtime,
      preferredRunGlobalId: listStage.runGlobalId,
      limit: 10,
    })
  assert.deepEqual(
    crashRecoveryTargets.map((target) => target.candidateGlobalId),
    [staleCandidate.global_id],
    'A sole system exact child must keep the original target selectable so a post-stage, pre-hook crash deterministically replays the same exact request',
  )
  assert.equal(crashRecoveryTargets[0].cohortHash, promotionCohortHash)
  assert.equal(crashRecoveryTargets[0].notBefore, promotionNotBefore)
  const supersededAttention = await persistence
    .markAutomaticFaireOrderPromotionAttentionInPostgres({
      runtime,
      actorEmail: systemActor,
      idempotencyKey:
        'commerce-staging-faire-auto-superseded-attention',
      candidateGlobalId: staleCandidate.global_id,
      candidateRowVersion: staleCandidate.row_version + 100,
      sourceHash: staleCandidate.source_hash,
      runGlobalId: listStage.runGlobalId,
      reasonCode: 'COMMERCE_FAIRE_EXACT_REFRESH_INTERRUPTED',
      cohortHash: promotionCohortHash,
      notBefore: promotionNotBefore,
      attentionKind: 'exact_refresh',
    })
  assert.equal(supersededAttention.marked, false)
  assert.equal(supersededAttention.reasonCode, 'newer_candidate_exists')
  assert.equal(
    supersededAttention.rowVersion,
    staleCandidate.row_version,
    'Verified newer-candidate authority must resolve benignly before a stale row-version conflict',
  )
  const resolvedMarkerScan = await completeFaireAttentionScan()
  assert.equal(
    resolvedMarkerScan.completed.faireAutomaticPromotionAttentionRequired,
    false,
  )
  assert.equal(
    resolvedMarkerScan.completed.faireExactRefreshAttentionRequired,
    false,
    'A marked:false exact race must persist neither attention subtype',
  )
  assert.equal(
    resolvedMarkerScan.completed.faireUnattributedAttentionRequired,
    false,
  )
  assert.equal(
    resolvedMarkerScan.health.providerPromotionAttentionRequired.faire,
    0,
  )
  assert.equal(
    resolvedMarkerScan.health.faireExactRefreshAttentionRequired,
    0,
  )
  assert.equal(resolvedMarkerScan.state.operatorAttentionRequired, false)
  let exactCandidate = (await pool.query(
    `SELECT global_id, row_version::integer, source_hash,
            header_money_state, header_money_gaps
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [ids.organization, ids.faireIntegrationAccount, externalOrderId],
  )).rows[0]
  assert.equal(exactCandidate.source_hash, exactOrder.sourceHash)
  const unresolvedTargets = await persistence
    .readAutomaticFaireOrderPromotionTargetsForRunInPostgres({
      runtime,
      runGlobalId: exactStage.runGlobalId,
    })
  assert.equal(unresolvedTargets[0].eligible, false)
  assert.equal(
    unresolvedTargets[0].reason,
    'customer_resolution_required',
    'Durable worker exact-read lineage must supersede only its stale list parent',
  )
  const resolved = await persistence.resolveCommerceCandidateCustomerInPostgres({
    runtime,
    actorEmail: systemActor,
    idempotencyKey: 'commerce-staging-faire-auto-customer',
    candidateGlobalId: exactCandidate.global_id,
    candidateRowVersion: exactCandidate.row_version,
    customer: {
      mode: 'existing',
      customerGlobalId,
      resolutionMethod: 'external_id',
    },
  })
  exactCandidate = {
    ...exactCandidate,
    row_version: resolved.rowVersion,
  }
  const eligibleTargets = await persistence
    .readAutomaticFaireOrderPromotionTargetsForRunInPostgres({
      runtime,
      runGlobalId: exactStage.runGlobalId,
    })
  assert.equal(eligibleTargets.length, 1)
  assert.equal(eligibleTargets[0].eligible, true)
  assert.equal(eligibleTargets[0].sourceHash, exactCandidate.source_hash)
  assert.equal(eligibleTargets[0].providerAddress, null)
  assert.equal(eligibleTargets[0].deliveryMode, null)
  const validation = await persistence.validateCommerceCandidateInPostgres({
    runtime,
    actorEmail: systemActor,
    idempotencyKey: 'commerce-staging-faire-auto-validate',
    candidateGlobalId: exactCandidate.global_id,
    candidateRowVersion: exactCandidate.row_version,
  })
  assert.equal(validation.ready, true)
  const promotionInput = {
    runtime,
    actorEmail: systemActor,
    idempotencyKey: 'commerce-staging-faire-auto-promote',
    candidateGlobalId: exactCandidate.global_id,
    candidateRowVersion: validation.rowVersion,
    requestHash: hash('commerce-staging-faire-auto-promote-request'),
    automaticFairePromotion: {
      policyVersion: 'commerce-faire-order-auto-promotion-v1',
      runGlobalId: exactStage.runGlobalId,
      sourceHash: exactCandidate.source_hash,
      cohortHash: promotionCohortHash,
      notBefore: promotionNotBefore,
    },
  }
  const promotionBlocker = await pool.connect()
  let promoted
  try {
    await promotionBlocker.query('BEGIN')
    await promotionBlocker.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [orderIdentityLockKey(externalOrderId)],
    )
    const promotionOutcome = persistence
      .promoteCommerceCandidateInPostgres(promotionInput)
      .then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      )
    await waitForAdvisoryWait('Candidate promotion')
    await promotionBlocker.query('COMMIT')
    const outcome = await promotionOutcome
    if (outcome.error) throw outcome.error
    promoted = outcome.value
  } finally {
    await promotionBlocker.query('ROLLBACK').catch(() => {})
    promotionBlocker.release()
  }
  assert.equal(promoted.providerWrites, 0)
  assert.equal(promoted.inventoryWrites, 0)
  const promotedReplay = await persistence.promoteCommerceCandidateInPostgres(
    promotionInput,
  )
  assert.equal(promotedReplay.replayed, true)
  assert.equal(
    promotedReplay.canonicalOrderGlobalId,
    promoted.canonicalOrderGlobalId,
  )
  const durable = (await pool.query(
    `SELECT canonical.source_payload, candidate.workflow_state,
            candidate.canonical_order_id::text,
            (SELECT count(*)::integer
             FROM operations_orders duplicate
             WHERE duplicate.organization_id = canonical.organization_id
               AND duplicate.integration_account_id
                   = canonical.integration_account_id
               AND duplicate.external_order_id = canonical.external_order_id)
              AS canonical_count,
            (SELECT count(*)::integer
             FROM operations_commerce_provider_attempts attempt
             WHERE attempt.organization_id = canonical.organization_id
               AND attempt.integration_account_id
                   = canonical.integration_account_id
               AND attempt.action <> 'commerce.intake.read')
              AS provider_write_attempts
     FROM operations_orders canonical
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = canonical.organization_id
      AND candidate.canonical_order_id = canonical.id
     WHERE canonical.organization_id = $1::uuid
       AND canonical.integration_account_id = $2::uuid
       AND canonical.external_order_id = $3`,
    [ids.organization, ids.faireIntegrationAccount, externalOrderId],
  )).rows[0]
  assert.equal(durable.workflow_state, 'promoted')
  assert.ok(durable.canonical_order_id)
  assert.equal(durable.canonical_count, 1)
  assert.equal(durable.provider_write_attempts, 0)
  assert.deepEqual(durable.source_payload.headerMoney, {
    state: 'operational_incomplete',
    unavailableFields: ['shipping', 'total'],
    fulfillmentDemandUse: 'exact_lines_only',
    accountingUse: 'blocked',
    customerChargeUse: 'blocked',
  })
  assert.equal(durable.source_payload.amountsMinor.shipping, null)
  assert.equal(durable.source_payload.amountsMinor.total, null)

  const raceKey = 'auto_exact_authority_race'
  const raceExternalOrderId = `faire-order-${raceKey}`
  await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       channel_sku, external_product_id, external_variant_id,
       mapping_method, mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
       'exact_variant', $8, true, $9
     )`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      ids.pipeline,
      ids.product,
      `POSTGRES-${raceKey}`,
      `p_${raceKey}`,
      `po_${raceKey}`,
      hash('faire-auto-exact-authority-race-mapping'),
      systemActor,
    ],
  )
  const raceBase = faireRetailerOrderFixture({
    key: raceKey,
    retailerId: 'retailer-auto-exact-authority-race',
    evidenceEmail: 'jarrett+authority-race@episcs.com',
  })
  const raceExactOrder = Object.freeze({
    ...raceBase,
    ...incompleteMoney,
    providerCreatedAt: freshObservedAt,
    providerProcessedAt: freshObservedAt,
    providerUpdatedAt: freshObservedAt,
    sourceStale: false,
    sourceHash: hash('faire-auto-exact-authority-race-current'),
  })
  const raceListOrder = Object.freeze({
    ...raceExactOrder,
    sourceStale: true,
    readinessFacts: Object.freeze([
      ...raceExactOrder.readinessFacts,
      Object.freeze({
        dimension: 'source',
        code: 'source_stale',
        blocking: true,
        subjectExternalId: raceExternalOrderId,
      }),
    ]),
    sourceHash: hash('faire-auto-exact-authority-race-list'),
  })
  const raceListRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009249',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-authority-race-list',
    responseHash: hash(
      'commerce-staging-faire-auto-authority-race-list-response',
    ),
    intakeAction: 'fetch',
    targetCandidate: null,
    externalOrderId: raceExternalOrderId,
  }
  await seedWorkerRead(raceListRead)
  const raceListStage = await stageWorkerEnvelope({
    read: raceListRead,
    action: 'fetch',
    order: raceListOrder,
    targetCandidate: null,
  })
  const raceSourceCandidate = (await pool.query(
    `SELECT global_id, row_version::integer, source_hash
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [ids.organization, ids.faireIntegrationAccount, raceExternalOrderId],
  )).rows[0]
  const raceExactRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009250',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-authority-race-exact',
    responseHash: hash(
      'commerce-staging-faire-auto-authority-race-exact-response',
    ),
    intakeAction: 'refresh',
    targetCandidate: {
      globalId: raceSourceCandidate.global_id,
      sourceHash: raceSourceCandidate.source_hash,
    },
    externalOrderId: raceExternalOrderId,
  }
  await seedWorkerRead(raceExactRead)
  const raceExactStage = await stageWorkerEnvelope({
    read: raceExactRead,
    action: 'refresh',
    order: raceExactOrder,
    targetCandidate: raceExactRead.targetCandidate,
  })
  let raceExactCandidate = (await pool.query(
    `SELECT global_id, row_version::integer, source_hash
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [ids.organization, ids.faireIntegrationAccount, raceExternalOrderId],
  )).rows[0]
  const raceCustomer = await persistence
    .resolveCommerceCandidateCustomerInPostgres({
      runtime,
      actorEmail: systemActor,
      idempotencyKey: 'commerce-staging-faire-auto-authority-race-customer',
      candidateGlobalId: raceExactCandidate.global_id,
      candidateRowVersion: raceExactCandidate.row_version,
      customer: {
        mode: 'existing',
        customerGlobalId,
        resolutionMethod: 'external_id',
      },
    })
  raceExactCandidate = {
    ...raceExactCandidate,
    row_version: raceCustomer.rowVersion,
  }
  const raceTargets = await persistence
    .readAutomaticFaireOrderPromotionTargetsForRunInPostgres({
      runtime,
      runGlobalId: raceExactStage.runGlobalId,
    })
  assert.equal(raceTargets.length, 1)
  assert.equal(raceTargets[0].eligible, true)
  const raceValidation = await persistence.validateCommerceCandidateInPostgres({
    runtime,
    actorEmail: systemActor,
    idempotencyKey: 'commerce-staging-faire-auto-authority-race-validate',
    candidateGlobalId: raceTargets[0].candidateGlobalId,
    candidateRowVersion: raceTargets[0].candidateRowVersion,
  })
  assert.equal(raceValidation.ready, true)
  const providerWritesBeforeRace = (await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_provider_attempts
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND action <> 'commerce.intake.read'`,
    [ids.organization, ids.faireIntegrationAccount],
  )).rows[0].count
  const inventoryRowsBeforeRace = (await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_inventory_positions
     WHERE organization_id = $1::uuid`,
    [ids.organization],
  )).rows[0].count
  await persistence.markCommerceCandidateUnsupportedInPostgres({
    runtime,
    actorEmail,
    idempotencyKey: 'commerce-staging-faire-auto-authority-race-human',
    candidateGlobalId: raceSourceCandidate.global_id,
    candidateRowVersion: raceSourceCandidate.row_version,
    reasonCode: 'operator_reviewed',
    reason: 'A human operator took ownership after automatic selection.',
  })
  await assert.rejects(
    persistence.promoteCommerceCandidateInPostgres({
      runtime,
      actorEmail: systemActor,
      idempotencyKey: 'commerce-staging-faire-auto-authority-race-promote',
      candidateGlobalId: raceTargets[0].candidateGlobalId,
      candidateRowVersion: raceValidation.rowVersion,
      requestHash: hash(
        'commerce-staging-faire-auto-authority-race-promote-request',
      ),
      automaticFairePromotion: {
        policyVersion: 'commerce-faire-order-auto-promotion-v1',
        runGlobalId: raceExactStage.runGlobalId,
        sourceHash: raceTargets[0].sourceHash,
        cohortHash: promotionCohortHash,
        notBefore: promotionNotBefore,
      },
    }),
    (error) => error?.code
      === 'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_AUTHORITY_STALE',
    'A human mutation after selection must revoke final promotion authority',
  )
  assert.equal((await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_orders
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3`,
    [ids.organization, ids.faireIntegrationAccount, raceExternalOrderId],
  )).rows[0].count, 0)
  assert.equal((await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_commerce_provider_attempts
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND action <> 'commerce.intake.read'`,
    [ids.organization, ids.faireIntegrationAccount],
  )).rows[0].count, providerWritesBeforeRace)
  assert.equal((await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_inventory_positions
     WHERE organization_id = $1::uuid`,
    [ids.organization],
  )).rows[0].count, inventoryRowsBeforeRace)
  assert.equal(raceListStage.providerWrites, 0)

  const rejectionKey = 'auto_exact_rejection'
  const rejectionExternalOrderId = `faire-order-${rejectionKey}`
  const rejectionBase = faireRetailerOrderFixture({
    key: rejectionKey,
    retailerId: 'retailer-auto-exact-rejection',
    evidenceEmail: 'jarrett+rejection@episcs.com',
  })
  const rejectionListOrder = Object.freeze({
    ...rejectionBase,
    providerCreatedAt: freshObservedAt,
    providerProcessedAt: freshObservedAt,
    providerUpdatedAt: freshObservedAt,
    sourceStale: true,
    readinessFacts: Object.freeze([
      ...rejectionBase.readinessFacts,
      Object.freeze({
        dimension: 'source',
        code: 'source_stale',
        blocking: true,
        subjectExternalId: rejectionExternalOrderId,
      }),
    ]),
    sourceHash: hash('faire-auto-exact-rejection-list'),
  })
  const rejectionSiblingKey = 'auto_exact_rejection_sibling'
  const rejectionSiblingBase = faireRetailerOrderFixture({
    key: rejectionSiblingKey,
    retailerId: 'retailer-auto-exact-rejection-sibling',
    evidenceEmail: 'jarrett+rejection-sibling@episcs.com',
  })
  const rejectionSiblingListOrder = Object.freeze({
    ...rejectionSiblingBase,
    providerCreatedAt: freshObservedAt,
    providerProcessedAt: freshObservedAt,
    providerUpdatedAt: freshObservedAt,
    sourceStale: true,
    readinessFacts: Object.freeze([
      ...rejectionSiblingBase.readinessFacts,
      Object.freeze({
        dimension: 'source',
        code: 'source_stale',
        blocking: true,
        subjectExternalId: `faire-order-${rejectionSiblingKey}`,
      }),
    ]),
    sourceHash: hash('faire-auto-exact-rejection-sibling-list'),
  })
  const rejectionListRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009242',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-rejection-list',
    responseHash: hash('commerce-staging-faire-auto-rejection-list-response'),
    intakeAction: 'fetch',
    targetCandidate: null,
    externalOrderId: rejectionExternalOrderId,
  }
  await seedWorkerRead(rejectionListRead)
  const rejectionListStage = await stageWorkerEnvelope({
    read: rejectionListRead,
    action: 'fetch',
    orders: [rejectionListOrder, rejectionSiblingListOrder],
    targetCandidate: null,
  })
  const rejectionSourceCandidate = (await pool.query(
    `SELECT global_id, row_version::integer, source_hash
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      rejectionExternalOrderId,
    ],
  )).rows[0]
  assert.equal(rejectionListStage.ordersStaged, 2)
  const rejectionExactRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009243',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-rejection-exact',
    responseHash: hash('commerce-staging-faire-auto-rejection-exact-response'),
    intakeAction: 'refresh',
    targetCandidate: {
      globalId: rejectionSourceCandidate.global_id,
      sourceHash: rejectionSourceCandidate.source_hash,
    },
    externalOrderId: rejectionExternalOrderId,
  }
  await seedWorkerRead(rejectionExactRead)
  const exactRejectionStage = await stageWorkerEnvelope({
    read: rejectionExactRead,
    action: 'refresh',
    order: null,
    orders: [],
    rejections: [Object.freeze({
      schemaVersion: 'commerce-normalization-rejection-v1',
      resourceType: 'order',
      externalId: rejectionExternalOrderId,
      sourceHash: hash('faire-auto-exact-rejection-current'),
      errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
      safeMessage: 'Exact Faire order failed normalized record validation',
    })],
    targetCandidate: rejectionExactRead.targetCandidate,
  })
  assert.equal(exactRejectionStage.ordersStaged, 0)
  assert.equal(exactRejectionStage.recordsRejected, 1)
  const exactRejectionEvidence = (await pool.query(
    `SELECT intent.intent_state, intent.target_global_id,
            intent.target_source_hash, rejection.disposition,
            rejection.external_id, rejection.error_code
     FROM operations_commerce_intake_read_intents intent
     JOIN operations_commerce_intake_runs run
       ON run.organization_id = intent.organization_id
      AND run.integration_account_id = intent.integration_account_id
      AND run.id = intent.staged_run_id
     JOIN operations_commerce_intake_rejections rejection
       ON rejection.organization_id = run.organization_id
      AND rejection.integration_account_id = run.integration_account_id
      AND rejection.run_id = run.id
     WHERE intent.id = $1::uuid`,
    [rejectionExactRead.readIntentId],
  )).rows[0]
  assert.deepEqual(exactRejectionEvidence, {
    intent_state: 'staged',
    target_global_id: rejectionSourceCandidate.global_id,
    target_source_hash: rejectionSourceCandidate.source_hash,
    disposition: 'open',
    external_id: rejectionExternalOrderId,
    error_code: 'COMMERCE_ORDER_RECORD_INVALID',
  })
  const exactRejectionAttentionInput = {
    runtime,
    actorEmail: systemActor,
    idempotencyKey: 'commerce-staging-faire-auto-rejection-attention',
    candidateGlobalId: rejectionSourceCandidate.global_id,
    candidateRowVersion: rejectionSourceCandidate.row_version,
    sourceHash: rejectionSourceCandidate.source_hash,
    runGlobalId: rejectionListStage.runGlobalId,
    reasonCode: 'COMMERCE_FAIRE_EXACT_REFRESH_NORMALIZATION_REJECTED',
    cohortHash: promotionCohortHash,
    notBefore: promotionNotBefore,
    attentionKind: 'exact_refresh',
  }
  const exactRejectionAttention = await persistence
    .markAutomaticFaireOrderPromotionAttentionInPostgres(
      exactRejectionAttentionInput,
    )
  assert.equal(exactRejectionAttention.marked, true)
  assert.equal(exactRejectionAttention.alreadyMarked, false)
  assert.equal(exactRejectionAttention.providerWrites, 0)
  assert.equal(exactRejectionAttention.inventoryWrites, 0)
  assert.equal(exactRejectionAttention.syncCursorAdvanced, false)
  const exactRejectionAttentionReplay = await persistence
    .markAutomaticFaireOrderPromotionAttentionInPostgres(
      exactRejectionAttentionInput,
    )
  assert.equal(exactRejectionAttentionReplay.replayed, true)
  const exactRejectionAttentionEvidence = (await pool.query(
    `SELECT candidate.last_error_code,
            candidate.row_version::integer,
            (SELECT count(*)::integer
             FROM operations_command_receipts receipt
             WHERE receipt.organization_id = candidate.organization_id
               AND receipt.command_type =
                   'commerce.intake.mark_faire_exact_refresh_attention'
               AND receipt.idempotency_key = $3) AS receipt_count,
            (SELECT count(*)::integer
             FROM audit_events event
             WHERE event.organization_id = candidate.organization_id
               AND event.aggregate_id = candidate.global_id
               AND event.event_type =
                   'commerce.intake.faire_exact_refresh.attention_marked')
              AS audit_count
     FROM operations_commerce_order_candidates candidate
     WHERE candidate.organization_id = $1::uuid
       AND candidate.global_id = $2`,
    [
      ids.organization,
      rejectionSourceCandidate.global_id,
      exactRejectionAttentionInput.idempotencyKey,
    ],
  )).rows[0]
  assert.deepEqual(exactRejectionAttentionEvidence, {
    last_error_code:
      'COMMERCE_FAIRE_EXACT_REFRESH_ATTENTION_REQUIRED',
    row_version: rejectionSourceCandidate.row_version + 1,
    receipt_count: 1,
    audit_count: 1,
  })
  assert.equal((await persistence
    .readAutomaticFaireExactRefreshTargetsInPostgres({
      runtime,
      preferredRunGlobalId: rejectionListStage.runGlobalId,
      limit: 10,
    })).some(
      (target) => target.candidateGlobalId
        === rejectionSourceCandidate.global_id,
    ), false, 'A marked exact outcome must not issue another provider read')
  const exactOnlyAttentionScan = await completeFaireAttentionScan({
    exactRefreshReviewRequired: 1,
  })
  assert.equal(
    exactOnlyAttentionScan.completed.faireAutomaticPromotionAttentionRequired,
    false,
  )
  assert.equal(
    exactOnlyAttentionScan.completed.faireExactRefreshAttentionRequired,
    true,
  )
  assert.equal(
    exactOnlyAttentionScan.completed.faireUnattributedAttentionRequired,
    false,
  )
  assert.equal(
    exactOnlyAttentionScan.health.providerPromotionAttentionRequired.faire,
    0,
    'Exact-only durable attention must not enter the promotion bucket',
  )
  assert.equal(
    exactOnlyAttentionScan.health.faireExactRefreshAttentionRequired,
    1,
  )
  assert.equal(
    exactOnlyAttentionScan.health.operatorAttentionRequired,
    1,
    'The aggregate account count must count one exact-only account once',
  )
  assert.equal(
    exactOnlyAttentionScan.state.automaticPromotionAttentionRequired,
    false,
  )
  assert.equal(
    exactOnlyAttentionScan.state.automaticExactRefreshAttentionRequired,
    true,
  )
  assert.equal(
    exactOnlyAttentionScan.state.automaticUnattributedAttentionRequired,
    false,
  )
  const emptyExactOnlyAttentionScan = await completeFaireAttentionScan()
  assert.equal(
    emptyExactOnlyAttentionScan.completed
      .faireAutomaticPromotionAttentionRequired,
    false,
  )
  assert.equal(
    emptyExactOnlyAttentionScan.completed.faireExactRefreshAttentionRequired,
    true,
    'A later empty poll must retain exact-only candidate attribution',
  )
  assert.equal(
    emptyExactOnlyAttentionScan.health.providerPromotionAttentionRequired.faire,
    0,
  )
  assert.equal(
    emptyExactOnlyAttentionScan.health.faireExactRefreshAttentionRequired,
    1,
  )
  const legacyCandidate = (await pool.query(
    `UPDATE operations_commerce_order_candidates
     SET last_error_code =
           'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED',
         row_version = row_version + 1,
         updated_by = 'system:commerce-order-reconciliation',
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND global_id = $3
     RETURNING row_version::integer`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      rejectionSourceCandidate.global_id,
    ],
  )).rows[0]
  await pool.query(
    `UPDATE operations_commerce_sync_cursors
     SET last_error_code = 'COMMERCE_ORDER_RECONCILIATION_PROVIDER_FAILED',
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND resource = 'orders'`,
    [ids.organization, ids.faireIntegrationAccount],
  )
  await pool.query(
    `ALTER TABLE operations_commerce_sync_cursors
       DROP COLUMN automatic_promotion_attention_required,
       DROP COLUMN automatic_exact_refresh_attention_required,
       DROP COLUMN automatic_unattributed_attention_required`,
  )
  await pool.query(read(
    'db/migrations/0251_operations_commerce_order_attention_kinds.sql',
  ))
  const legacyMigrationState = await reconciliationPersistence
    .readCommerceOrderReconciliationStateInPostgres({
      organizationId: ids.organization,
      accountGlobalId: runtime.globalId,
    })
  assert.equal(
    legacyMigrationState.lastErrorCode,
    'COMMERCE_ORDER_RECONCILIATION_PROVIDER_FAILED',
    'The migration test must begin with an overwritten cursor error code',
  )
  assert.equal(
    legacyMigrationState.automaticPromotionAttentionRequired,
    false,
    'A legacy generic marker must not be backfilled as promotion',
  )
  assert.equal(
    legacyMigrationState.automaticExactRefreshAttentionRequired,
    false,
    'A legacy generic marker must not be guessed as exact refresh',
  )
  assert.equal(
    legacyMigrationState.automaticUnattributedAttentionRequired,
    true,
    'Candidate evidence must recover legacy attention after cursor error overwrite',
  )
  assert.equal(legacyMigrationState.operatorAttentionRequired, true)
  const legacyRemark = await persistence
    .markAutomaticFaireOrderPromotionAttentionInPostgres({
      ...exactRejectionAttentionInput,
      idempotencyKey: 'commerce-staging-faire-legacy-attention-remark',
      candidateRowVersion: legacyCandidate.row_version,
      reasonCode: 'validation_blocked',
      attentionKind: 'promotion',
    })
  assert.equal(legacyRemark.marked, false)
  assert.equal(legacyRemark.alreadyMarked, true)
  assert.equal(legacyRemark.attentionKind, 'unattributed')
  assert.equal(
    (await pool.query(
      `SELECT last_error_code
       FROM operations_commerce_order_candidates
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND global_id = $3`,
      [
        ids.organization,
        ids.faireIntegrationAccount,
        rejectionSourceCandidate.global_id,
      ],
    )).rows[0].last_error_code,
    'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED',
    'A new typed attempt must not relabel ambiguous legacy evidence',
  )
  const legacyFailureScan = await completeFaireAttentionScan({
    failureCode: 'COMMERCE_ORDER_RECONCILIATION_PROVIDER_FAILED',
  })
  assert.equal(
    legacyFailureScan.health.providerPromotionAttentionRequired.faire,
    0,
  )
  assert.equal(legacyFailureScan.health.faireExactRefreshAttentionRequired, 0)
  assert.equal(legacyFailureScan.health.faireUnattributedAttentionRequired, 1)
  assert.equal(legacyFailureScan.health.operatorAttentionRequired, 1)
  assert.equal(
    legacyFailureScan.state.automaticUnattributedAttentionRequired,
    true,
    'A reconciliation failure must not erase legacy aggregate attention',
  )
  const legacyEmptyAttentionScan = await completeFaireAttentionScan()
  assert.equal(
    legacyEmptyAttentionScan.completed
      .faireAutomaticPromotionAttentionRequired,
    false,
  )
  assert.equal(
    legacyEmptyAttentionScan.completed.faireExactRefreshAttentionRequired,
    false,
  )
  assert.equal(
    legacyEmptyAttentionScan.completed.faireUnattributedAttentionRequired,
    true,
    'A later empty poll must preserve legacy unattributed candidate evidence',
  )
  assert.equal(
    legacyEmptyAttentionScan.health.faireUnattributedAttentionRequired,
    1,
  )
  assert.equal(legacyEmptyAttentionScan.health.operatorAttentionRequired, 1)
  const mismatchedExactRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009246',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-rejection-mismatch',
    responseHash: hash('commerce-staging-faire-auto-rejection-mismatch-response'),
    intakeAction: 'refresh',
    targetCandidate: rejectionExactRead.targetCandidate,
    externalOrderId: rejectionExternalOrderId,
  }
  await seedWorkerRead(mismatchedExactRead)
  await assert.rejects(
    stageWorkerEnvelope({
      read: mismatchedExactRead,
      action: 'refresh',
      order: null,
      orders: [],
      rejections: [Object.freeze({
        schemaVersion: 'commerce-normalization-rejection-v1',
        resourceType: 'order',
        externalId: 'faire-order-different-identity',
        sourceHash: hash('faire-auto-exact-rejection-wrong-identity'),
        errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
        safeMessage: 'Different exact Faire order identity',
      })],
      targetCandidate: mismatchedExactRead.targetCandidate,
    }),
    (error) => error?.code === 'COMMERCE_INTAKE_EXACT_ORDER_TARGET_MISMATCH',
  )
  await assert.rejects(
    stageWorkerEnvelope({
      read: mismatchedExactRead,
      action: 'refresh',
      order: null,
      orders: [],
      rejections: [
        Object.freeze({
          schemaVersion: 'commerce-normalization-rejection-v1',
          resourceType: 'order',
          externalId: rejectionExternalOrderId,
          sourceHash: hash('faire-auto-exact-rejection-matching-ambiguous'),
          errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
          safeMessage: 'Matching identity in an ambiguous exact response',
        }),
        Object.freeze({
          schemaVersion: 'commerce-normalization-rejection-v1',
          resourceType: 'order',
          externalId: 'faire-order-different-identity',
          sourceHash: hash('faire-auto-exact-rejection-extra-identity'),
          errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
          safeMessage: 'Extra identity in an ambiguous exact response',
        }),
      ],
      targetCandidate: mismatchedExactRead.targetCandidate,
    }),
    (error) => error?.code === 'COMMERCE_INTAKE_EXACT_ORDER_TARGET_MISMATCH',
  )
  assert.deepEqual((await pool.query(
    `SELECT intent_state, staged_run_id::text,
            (SELECT count(*)::integer
             FROM operations_commerce_intake_runs run
             WHERE run.organization_id = intent.organization_id
               AND run.integration_account_id = intent.integration_account_id
               AND run.idempotency_key = $2) AS run_count
     FROM operations_commerce_intake_read_intents intent
     WHERE intent.id = $1::uuid`,
    [mismatchedExactRead.readIntentId, mismatchedExactRead.idempotencyKey],
  )).rows[0], {
    intent_state: 'captured',
    staged_run_id: null,
    run_count: 0,
  })
  const rejectionSiblingCandidate = (await pool.query(
    `SELECT global_id
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      `faire-order-${rejectionSiblingKey}`,
    ],
  )).rows[0]
  const firstRankedRetryTarget = (await persistence
    .readAutomaticFaireExactRefreshTargetsInPostgres({
      runtime,
      preferredRunGlobalId: rejectionListStage.runGlobalId,
      limit: 1,
    }))[0]
  assert.equal(
    firstRankedRetryTarget.candidateGlobalId,
    rejectionSiblingCandidate.global_id,
    'Fresh exact-read work must rank ahead of replay-only durable attention in the same run',
  )
  assert.equal((await persistence
    .readAutomaticFaireExactRefreshTargetsInPostgres({
      runtime,
      preferredRunGlobalId: rejectionListStage.runGlobalId,
      limit: 10,
    })).some(
      (target) => target.candidateGlobalId
        === rejectionSourceCandidate.global_id,
    ), false, 'Candidate attention provenance replaces replay-only exact retries')

  const humanActor = 'jarrett+faire-manual-history@episcs.com'
  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES ($1, 'owner', 'active')
     ON CONFLICT (email) DO NOTHING`,
    [humanActor],
  )
  const manualKey = 'auto_exact_manual_history'
  const manualExternalOrderId = `faire-order-${manualKey}`
  const manualBaseOrder = faireRetailerOrderFixture({
    key: manualKey,
    retailerId: 'retailer-auto-exact-manual-history',
    evidenceEmail: 'jarrett+manual-history@episcs.com',
  })
  const manualStaleOrder = (sourceHash) => Object.freeze({
    ...manualBaseOrder,
    ...incompleteMoney,
    providerCreatedAt: freshObservedAt,
    providerProcessedAt: freshObservedAt,
    providerUpdatedAt: freshObservedAt,
    sourceStale: true,
    readinessFacts: Object.freeze([
      ...manualBaseOrder.readinessFacts,
      Object.freeze({
        dimension: 'source',
        code: 'source_stale',
        blocking: true,
        subjectExternalId: manualExternalOrderId,
      }),
    ]),
    sourceHash,
  })
  const manualRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009247',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-manual-history',
    responseHash: hash('commerce-staging-faire-manual-history-response'),
    intakeAction: 'fetch',
    targetCandidate: null,
    actorEmail: humanActor,
  }
  await seedWorkerRead(manualRead)
  await stageWorkerEnvelope({
    read: manualRead,
    action: 'fetch',
    order: manualStaleOrder(hash('faire-auto-manual-history-first')),
    targetCandidate: null,
  })
  const laterSystemRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009248',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-system-after-manual-history',
    responseHash: hash(
      'commerce-staging-faire-system-after-manual-history-response',
    ),
    intakeAction: 'fetch',
    targetCandidate: null,
  }
  await seedWorkerRead(laterSystemRead)
  const stagingBlocker = await pool.connect()
  let laterSystemStage
  try {
    await stagingBlocker.query('BEGIN')
    await stagingBlocker.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [orderIdentityLockKey(manualExternalOrderId)],
    )
    const stageOutcome = stageWorkerEnvelope({
      read: laterSystemRead,
      action: 'fetch',
      order: manualStaleOrder(hash('faire-auto-manual-history-second')),
      targetCandidate: null,
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )
    await waitForAdvisoryWait('Order staging')
    await stagingBlocker.query('COMMIT')
    const outcome = await stageOutcome
    if (outcome.error) throw outcome.error
    laterSystemStage = outcome.value
  } finally {
    await stagingBlocker.query('ROLLBACK').catch(() => {})
    stagingBlocker.release()
  }
  const laterSystemCandidate = (await pool.query(
    `SELECT global_id
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [ids.organization, ids.faireIntegrationAccount, manualExternalOrderId],
  )).rows[0]
  assert.equal((await persistence
    .readAutomaticFaireExactRefreshTargetsInPostgres({
      runtime,
      preferredRunGlobalId: laterSystemStage.runGlobalId,
      limit: 10,
    })).some(
      (target) => target.candidateGlobalId === laterSystemCandidate.global_id,
    ), false, 'Older browser-owned order history must block unattended exact refresh')
  const manualHistoryPromotion = await persistence
    .readAutomaticFaireOrderPromotionTargetsForRunInPostgres({
      runtime,
      runGlobalId: laterSystemStage.runGlobalId,
    })
  assert.equal(manualHistoryPromotion[0].eligible, false)
  assert.equal(
    manualHistoryPromotion[0].reason,
    'operator_owned_history',
    'Browser-owned history must remain held without creating new unattended attention',
  )

  const packKey = 'auto_exact_missing_pack'
  const packExternalOrderId = `faire-order-${packKey}`
  await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       channel_sku, external_product_id, external_variant_id,
       mapping_method, mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
       'exact_variant', $8, true, $9
     )`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      ids.pipeline,
      ids.product,
      `POSTGRES-${packKey}`,
      `p_${packKey}`,
      `po_${packKey}`,
      hash('faire-auto-exact-missing-pack-mapping'),
      systemActor,
    ],
  )
  const packBase = fairePackOrderFixture({
    key: packKey,
    retailerId: 'retailer-auto-exact-missing-pack',
    evidenceEmail: 'jarrett+missing-pack@episcs.com',
  })
  const packExactOrder = Object.freeze({
    ...packBase,
    providerCreatedAt: freshObservedAt,
    providerProcessedAt: freshObservedAt,
    providerUpdatedAt: freshObservedAt,
    sourceStale: false,
    sourceHash: hash('faire-auto-exact-missing-pack-current'),
  })
  const packListOrder = Object.freeze({
    ...packExactOrder,
    sourceStale: true,
    readinessFacts: Object.freeze([
      ...packExactOrder.readinessFacts,
      Object.freeze({
        dimension: 'source',
        code: 'source_stale',
        blocking: true,
        subjectExternalId: packExternalOrderId,
      }),
    ]),
    sourceHash: hash('faire-auto-exact-missing-pack-list'),
  })
  const packListRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009244',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-pack-list',
    responseHash: hash('commerce-staging-faire-auto-pack-list-response'),
    intakeAction: 'fetch',
    targetCandidate: null,
    externalOrderId: packExternalOrderId,
  }
  await seedWorkerRead(packListRead)
  const packListStage = await stageWorkerEnvelope({
    read: packListRead,
    action: 'fetch',
    order: packListOrder,
    targetCandidate: null,
  })
  const packSourceCandidate = (await pool.query(
    `SELECT global_id, row_version::integer, source_hash
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [ids.organization, ids.faireIntegrationAccount, packExternalOrderId],
  )).rows[0]
  const packExactRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009245',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-faire-auto-pack-exact',
    responseHash: hash('commerce-staging-faire-auto-pack-exact-response'),
    intakeAction: 'refresh',
    targetCandidate: {
      globalId: packSourceCandidate.global_id,
      sourceHash: packSourceCandidate.source_hash,
    },
    externalOrderId: packExternalOrderId,
  }
  await seedWorkerRead(packExactRead)
  const packExactStage = await stageWorkerEnvelope({
    read: packExactRead,
    action: 'refresh',
    order: packExactOrder,
    targetCandidate: packExactRead.targetCandidate,
  })
  const packExactCandidate = (await pool.query(
    `SELECT candidate.global_id, candidate.row_version::integer,
            candidate.blocking_codes,
            line.packaging_state, line.mapping_state,
            line.price_resolution_state
     FROM operations_commerce_order_candidates candidate
     JOIN operations_commerce_order_candidate_lines line
       ON line.organization_id = candidate.organization_id
      AND line.integration_account_id = candidate.integration_account_id
      AND line.order_candidate_id = candidate.id
     WHERE candidate.organization_id = $1::uuid
       AND candidate.integration_account_id = $2::uuid
       AND candidate.external_order_id = $3
     ORDER BY candidate.observed_at DESC, candidate.created_at DESC,
              candidate.id DESC
     LIMIT 1`,
    [ids.organization, ids.faireIntegrationAccount, packExternalOrderId],
  )).rows[0]
  assert.equal(packExactCandidate.mapping_state, 'resolved')
  assert.equal(packExactCandidate.price_resolution_state, 'provider')
  assert.equal(packExactCandidate.packaging_state, 'unresolved')
  assert.ok(packExactCandidate.blocking_codes.includes('packaging_required'))
  const packCustomer = await persistence
    .resolveCommerceCandidateCustomerInPostgres({
      runtime,
      actorEmail: systemActor,
      idempotencyKey: 'commerce-staging-faire-auto-pack-customer',
      candidateGlobalId: packExactCandidate.global_id,
      candidateRowVersion: packExactCandidate.row_version,
      customer: {
        mode: 'existing',
        customerGlobalId,
        resolutionMethod: 'external_id',
      },
    })
  assert.ok(packCustomer.rowVersion > packExactCandidate.row_version)
  const packTargets = await persistence
    .readAutomaticFaireOrderPromotionTargetsForRunInPostgres({
      runtime,
      runGlobalId: packExactStage.runGlobalId,
    })
  assert.equal(packTargets.length, 1)
  assert.equal(packTargets[0].eligible, false)
  assert.equal(
    packTargets[0].reason,
    'product_sku_or_pack_mapping_requires_review',
    'Missing package evidence must remain an actionable no-go hold',
  )
  const packAttentionInput = {
    runtime,
    actorEmail: systemActor,
    idempotencyKey: 'commerce-staging-faire-auto-pack-attention',
    candidateGlobalId: packTargets[0].candidateGlobalId,
    candidateRowVersion: packTargets[0].candidateRowVersion,
    sourceHash: packTargets[0].sourceHash,
    runGlobalId: packExactStage.runGlobalId,
    reasonCode: packTargets[0].reason,
    cohortHash: promotionCohortHash,
    notBefore: promotionNotBefore,
    attentionKind: 'promotion',
  }
  const packAttention = await persistence
    .markAutomaticFaireOrderPromotionAttentionInPostgres(packAttentionInput)
  assert.equal(packAttention.marked, true)
  assert.equal(packAttention.alreadyMarked, false)
  assert.equal(packAttention.providerWrites, 0)
  assert.equal(packAttention.inventoryWrites, 0)
  assert.equal((await persistence
    .readAutomaticFaireOrderPromotionTargetsForRunInPostgres({
      runtime,
      runGlobalId: packExactStage.runGlobalId,
    })).length, 0, 'Marked actionable Faire candidates must leave the selector')

  await persistence.markCommerceCandidateUnsupportedInPostgres({
    runtime,
    actorEmail: humanActor,
    idempotencyKey: 'commerce-staging-faire-auto-rejection-resolved',
    candidateGlobalId: rejectionSourceCandidate.global_id,
    candidateRowVersion: legacyCandidate.row_version,
    reasonCode: 'operator_resolved',
    reason: 'Operator reviewed and resolved the exact-read rejection.',
  })
  const promotionOnlyAttentionScan = await completeFaireAttentionScan({
    promotionReviewRequired: 1,
  })
  assert.equal(
    promotionOnlyAttentionScan.completed
      .faireAutomaticPromotionAttentionRequired,
    true,
  )
  assert.equal(
    promotionOnlyAttentionScan.completed.faireExactRefreshAttentionRequired,
    false,
    'Promotion-only attention must not enter the exact-refresh bucket',
  )
  assert.equal(
    promotionOnlyAttentionScan.completed.faireUnattributedAttentionRequired,
    false,
  )
  assert.equal(
    promotionOnlyAttentionScan.health.providerPromotionAttentionRequired.faire,
    1,
  )
  assert.equal(
    promotionOnlyAttentionScan.health.faireExactRefreshAttentionRequired,
    0,
  )
  assert.equal(
    promotionOnlyAttentionScan.health.operatorAttentionRequired,
    1,
    'A promotion-only account must count once in aggregate operator attention',
  )
  assert.equal(
    promotionOnlyAttentionScan.state.automaticPromotionAttentionRequired,
    true,
  )
  assert.equal(
    promotionOnlyAttentionScan.state.automaticExactRefreshAttentionRequired,
    false,
  )
  assert.equal(
    promotionOnlyAttentionScan.state.automaticUnattributedAttentionRequired,
    false,
  )
  assert.equal(
    promotionOnlyAttentionScan.state.lastErrorCode,
    'COMMERCE_FAIRE_PROMOTION_ATTENTION_REQUIRED',
    'New promotion attention must never reuse the ambiguous legacy marker',
  )

  const packMixedAttention = await persistence
    .markAutomaticFaireOrderPromotionAttentionInPostgres({
      ...packAttentionInput,
      idempotencyKey: 'commerce-staging-faire-auto-pack-exact-attention',
      candidateRowVersion: packAttention.rowVersion,
      reasonCode: 'COMMERCE_FAIRE_EXACT_REFRESH_INTERRUPTED',
      attentionKind: 'exact_refresh',
    })
  assert.equal(packMixedAttention.marked, true)
  assert.equal(packMixedAttention.alreadyMarked, false)
  assert.equal((await pool.query(
    `SELECT last_error_code
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND global_id = $3`,
    [
      ids.organization,
      ids.faireIntegrationAccount,
      packAttention.candidateGlobalId,
    ],
  )).rows[0].last_error_code,
  'COMMERCE_FAIRE_PROMOTION_AND_EXACT_REFRESH_ATTENTION_REQUIRED')

  const attentionScan = await completeFaireAttentionScan({
    promotionReviewRequired: 1,
    exactRefreshReviewRequired: 1,
  })
  assert.equal(
    attentionScan.completed.faireAutomaticPromotionAttentionRequired,
    true,
  )
  assert.equal(
    attentionScan.completed.faireExactRefreshAttentionRequired,
    true,
    'Mixed unresolved candidates must retain both attention subtypes',
  )
  assert.equal(
    attentionScan.completed.faireUnattributedAttentionRequired,
    false,
  )
  assert.equal(
    attentionScan.health.providerPromotionAttentionRequired.faire,
    1,
  )
  assert.equal(attentionScan.health.faireExactRefreshAttentionRequired, 1)
  assert.equal(
    attentionScan.health.operatorAttentionRequired,
    1,
    'A mixed account must count once in aggregate operator attention',
  )
  assert.equal(attentionScan.state.automaticPromotionAttentionRequired, true)
  assert.equal(
    attentionScan.state.automaticExactRefreshAttentionRequired,
    true,
  )
  const emptyAttentionScan = await completeFaireAttentionScan()
  assert.equal(
    emptyAttentionScan.completed.faireAutomaticPromotionAttentionRequired,
    true,
    'A later empty root scan must retain candidate-scoped Faire attention',
  )
  assert.equal(
    emptyAttentionScan.completed.faireExactRefreshAttentionRequired,
    true,
    'A later empty root scan must preserve mixed subtype attribution',
  )
  assert.equal(
    emptyAttentionScan.health.providerPromotionAttentionRequired.faire,
    1,
  )
  assert.equal(emptyAttentionScan.health.faireExactRefreshAttentionRequired, 1)
  assert.equal(
    emptyAttentionScan.state.automaticPromotionAttentionRequired,
    true,
  )
  assert.equal(
    emptyAttentionScan.state.automaticExactRefreshAttentionRequired,
    true,
  )

  await persistence.markCommerceCandidateUnsupportedInPostgres({
    runtime,
    actorEmail: humanActor,
    idempotencyKey: 'commerce-staging-faire-auto-pack-resolved',
    candidateGlobalId: packAttention.candidateGlobalId,
    candidateRowVersion: packMixedAttention.rowVersion,
    reasonCode: 'operator_resolved',
    reason: 'Operator reviewed and resolved the package mapping hold.',
  })
  const markerHistory = (await pool.query(
    `SELECT
       count(*) FILTER (
         WHERE last_error_code IN (
           'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED',
           'COMMERCE_FAIRE_PROMOTION_ATTENTION_REQUIRED',
           'COMMERCE_FAIRE_EXACT_REFRESH_ATTENTION_REQUIRED',
           'COMMERCE_FAIRE_PROMOTION_AND_EXACT_REFRESH_ATTENTION_REQUIRED'
         )
       )::integer AS active_markers,
       count(*) FILTER (
         WHERE external_order_id = $3
           AND last_error_code IS NULL
       )::integer AS historical_unmarked
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [ids.organization, ids.faireIntegrationAccount, manualExternalOrderId],
  )).rows[0]
  assert.deepEqual(markerHistory, {
    active_markers: 0,
    historical_unmarked: 2,
  })
  const clearedAttentionScan = await completeFaireAttentionScan()
  assert.equal(
    clearedAttentionScan.completed.faireAutomaticPromotionAttentionRequired,
    false,
    'Resolved markers and historical unmarked records must clear attention',
  )
  assert.equal(
    clearedAttentionScan.health.providerPromotionAttentionRequired.faire,
    0,
  )
  assert.equal(clearedAttentionScan.health.faireExactRefreshAttentionRequired, 0)
  assert.equal(clearedAttentionScan.health.faireUnattributedAttentionRequired, 0)
  assert.equal(
    clearedAttentionScan.state.automaticPromotionAttentionRequired,
    false,
  )
  assert.equal(
    clearedAttentionScan.state.automaticExactRefreshAttentionRequired,
    false,
  )
  assert.equal(
    clearedAttentionScan.state.automaticUnattributedAttentionRequired,
    false,
  )
  assert.equal(clearedAttentionScan.state.lastErrorCode, null)
  assert.equal((await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_orders
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND external_order_id = $3`,
    [ids.organization, ids.faireIntegrationAccount, packExternalOrderId],
  )).rows[0].count, 0)
  assert.equal(packListStage.providerWrites, 0)
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
    faireIntegrationAccount: randomUUID(),
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
  const imageFixture = productImageFixture()
  const providerClockAheadRetentionExpiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1_000 + 60_000,
  ).toISOString()
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
    retentionExpiresAt: providerClockAheadRetentionExpiresAt,
    sourceHash: hash('commerce-staging-envelope'),
    products: Object.freeze([imageFixture.product]),
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

  const counters = {
    auditEvents: 0,
    fetchCalls: 0,
    activeTransactionClient: null,
    expectedImageStage: null,
    imageReconcileCalls: [],
    imageReconcileError: null,
    catalogPolicyApplications: [],
  }
  const persistence = loadCommerceStagingService(pool, counters)
  await verifyReviewTerminalCatalogRecovery({
    pool,
    ids,
    persistence,
    counters,
  })
  counters.auditEvents = 0
  const stageInput = {
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
  }
  const expectPreStageRejection = async (input, code) => {
    const callsBefore = counters.imageReconcileCalls.length
    await assert.rejects(
      persistence.stageCommerceNormalizationEnvelopeInPostgres(input),
      (error) => error?.code === code,
    )
    assert.equal(
      counters.imageReconcileCalls.length,
      callsBefore,
      `${code} must reject before product-image reconciliation`,
    )
  }
  await expectPreStageRejection({
    ...stageInput,
    envelope: Object.freeze({
      ...envelope,
      organizationId: randomUUID(),
    }),
  }, 'COMMERCE_NORMALIZATION_SCOPE_MISMATCH')
  await expectPreStageRejection({
    ...stageInput,
    idempotencyKey: 'commerce-staging-postgres-continuation-invalid',
    page: null,
  }, 'COMMERCE_INTAKE_CONTINUATION_INVALID')
  await expectPreStageRejection({
    ...stageInput,
    idempotencyKey: 'commerce-staging-postgres-intent-invalid',
    readIntentId: randomUUID(),
  }, 'COMMERCE_INTAKE_INTENT_INVALID')
  const exactMismatchRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009204',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-postgres-exact-order-mismatch',
    responseHash: hash('commerce-staging-exact-order-mismatch-response'),
  }
  const exactMissingOrderHash = hash(JSON.stringify(
    'gid://shopify/Order/not-returned',
  ))
  const exactMismatchSeed = await pool.connect()
  try {
    await seedAdditionalCapturedRead(exactMismatchSeed, ids, {
      ...exactMismatchRead,
      redactedRequest: { targetHash: exactMissingOrderHash },
    })
  } finally {
    exactMismatchSeed.release()
  }
  await expectPreStageRejection({
    ...stageInput,
    idempotencyKey: exactMismatchRead.idempotencyKey,
    envelope: Object.freeze({
      ...envelope,
      sourceHash: hash('commerce-staging-exact-order-mismatch-envelope'),
      products: Object.freeze([]),
      orders: Object.freeze([envelope.orders[0]]),
    }),
    page: {
      ...stageInput.page,
      sessionId: exactMismatchRead.sessionId,
      providerRowsSeen: 1,
      eligibleOrdersSeen: 1,
    },
    readIntentId: exactMismatchRead.readIntentId,
    capturedResponseHash: exactMismatchRead.responseHash,
    exactExternalOrderIdHash: exactMissingOrderHash,
  }, 'COMMERCE_INTAKE_EXACT_ORDER_TARGET_MISMATCH')

  counters.expectedImageStage = {
    idempotencyKey: ids.idempotencyKey,
    readIntentId: ids.readIntent,
  }
  const result = await persistence.stageCommerceNormalizationEnvelopeInPostgres(
    stageInput,
  )
  assert.equal(result.replayed, false)
  assert.equal(result.ordersStaged, 6)
  assert.equal(result.recordsStaged, 6)
  assert.equal(result.providerWrites, 0)
  assert.equal(result.syncCursorAdvanced, false)
  const retention = (await pool.query(
    `SELECT
       run.expires_at > run.created_at AS remains_unexpired,
       run.expires_at <= run.created_at + interval '30 days'
         AS database_bounded,
       run.expires_at < $2::timestamptz AS provider_clock_clamped,
       (
         SELECT count(*)::integer
         FROM operations_commerce_product_candidates product_candidate
         WHERE product_candidate.run_id = run.id
           AND product_candidate.expires_at IS DISTINCT FROM run.expires_at
       ) AS product_expiry_mismatches,
       (
         SELECT count(*)::integer
         FROM operations_commerce_order_candidates candidate
         WHERE candidate.run_id = run.id
           AND candidate.expires_at IS DISTINCT FROM run.expires_at
       ) AS order_expiry_mismatches,
       (
         SELECT count(*)::integer
         FROM operations_commerce_order_candidate_lines line
         WHERE line.run_id = run.id
           AND line.expires_at IS DISTINCT FROM run.expires_at
       ) AS line_expiry_mismatches
     FROM operations_commerce_intake_runs run
     WHERE run.organization_id = $1::uuid
       AND run.global_id = $3`,
    [
      ids.organization,
      providerClockAheadRetentionExpiresAt,
      result.runGlobalId,
    ],
  )).rows[0]
  assert.deepEqual(retention, {
    remains_unexpired: true,
    database_bounded: true,
    provider_clock_clamped: true,
    product_expiry_mismatches: 0,
    order_expiry_mismatches: 0,
    line_expiry_mismatches: 0,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result.productImageImports)), {
    productsObserved: 1,
    activeImagesObserved: 1,
    removedImagesObserved: 0,
    staleSnapshotsIgnored: 0,
    jobsByState: {
      waiting_mapping: 0,
      queued: 1,
      claimed: 0,
      retry: 0,
      succeeded: 0,
      dead: 0,
      cancelled: 0,
    },
    providerWrites: 0,
    syncCursorAdvanced: false,
  })
  assert.equal(counters.imageReconcileCalls.length, 1)
  const imageCall = counters.imageReconcileCalls[0]
  assert.strictEqual(imageCall.client, imageCall.transactionClient)
  assert.deepEqual(imageCall.input, {
    organizationId: ids.organization,
    integrationAccountId: ids.integrationAccount,
    provider: 'shopify',
    credentialGeneration: 1,
    externalProductId: imageFixture.product.identity.value,
    productSourceHash: imageFixture.product.sourceHash,
    productLifecycle: 'active',
    imageSetComplete: true,
    observedAt,
    providerUpdatedAt: observedAt,
    actorEmail,
    images: [imageFixture.expectedObservation],
  })
  assert.doesNotMatch(
    JSON.stringify(imageCall.input),
    /https?:\/\//u,
    'Durable image reconciliation input must remain URL-free',
  )
  assert.notEqual(
    imageCall.input.images[0].sourceHash,
    imageCall.input.productSourceHash,
    'Image observation hashes must not churn with the whole product source',
  )
  assert.equal(counters.fetchCalls, 0)
  assert.equal(counters.auditEvents, 1)

  const automaticCustomerTargets = await persistence
    .readAutomaticCommerceCustomerTargetsForRunInPostgres({
      runtime: stageInput.runtime,
      runGlobalId: result.runGlobalId,
    })
  assert.equal(
    automaticCustomerTargets.length,
    6,
    'Order candidates must remain discoverable through their internal products-and-orders intake run',
  )
  assert.deepEqual(
    automaticCustomerTargets.map((target) => target.provider),
    Array(6).fill('shopify'),
  )

  const imageCallsBeforeDirectReplay = counters.imageReconcileCalls.length
  const replay = await persistence.stageCommerceNormalizationEnvelopeInPostgres(
    stageInput,
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(replay)),
    {
      ...JSON.parse(JSON.stringify(result)),
      replayed: true,
    },
    'A direct same-key stage replay must return the exact committed summary',
  )
  assert.equal(
    counters.imageReconcileCalls.length,
    imageCallsBeforeDirectReplay,
    'A stage replay must not reconcile product images twice',
  )
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
    attempts: 2,
    cursors: 0,
  })
  const readEvidence = await pool.query(
    `SELECT attempt.state, intent.intent_state
     FROM operations_commerce_provider_attempts attempt
     JOIN operations_commerce_intake_read_intents intent
       ON intent.organization_id = attempt.organization_id
      AND intent.integration_account_id = attempt.integration_account_id
      AND intent.provider_attempt_id = attempt.id
     WHERE attempt.organization_id = $1
       AND attempt.id = $2::uuid`,
    [ids.organization, ids.providerAttempt],
  )
  assert.deepEqual(readEvidence.rows[0], {
    state: 'succeeded',
    intent_state: 'staged',
  })

  const rollbackRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009202',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-postgres-image-rollback',
    responseHash: hash('commerce-staging-image-rollback-response'),
  }
  const rollbackSeed = await pool.connect()
  try {
    await seedAdditionalCapturedRead(rollbackSeed, ids, rollbackRead)
  } finally {
    rollbackSeed.release()
  }
  const stageEffectsBeforeRollback = (
    await pool.query(
      `SELECT
         (SELECT count(*)::integer
          FROM operations_commerce_intake_runs
          WHERE organization_id = $1::uuid) AS runs,
         (SELECT count(*)::integer
          FROM operations_commerce_order_candidates
          WHERE organization_id = $1::uuid) AS candidates,
         (SELECT count(*)::integer
          FROM operations_commerce_order_candidate_lines
          WHERE organization_id = $1::uuid) AS candidate_lines,
         (SELECT count(*)::integer
          FROM operations_commerce_intake_continuations
          WHERE organization_id = $1::uuid) AS continuations`,
      [ids.organization],
    )
  ).rows[0]
  const imageCallsBeforeRollback = counters.imageReconcileCalls.length
  const auditEventsBeforeRollback = counters.auditEvents
  counters.expectedImageStage = {
    idempotencyKey: rollbackRead.idempotencyKey,
    readIntentId: rollbackRead.readIntentId,
  }
  counters.imageReconcileError = new Error(
    'commerce product image reconcile rollback sentinel',
  )
  try {
    await assert.rejects(
      persistence.stageCommerceNormalizationEnvelopeInPostgres({
        ...stageInput,
        idempotencyKey: rollbackRead.idempotencyKey,
        envelope: Object.freeze({
          ...envelope,
          sourceHash: hash('commerce-staging-image-rollback-envelope'),
        }),
        page: {
          ...stageInput.page,
          sessionId: rollbackRead.sessionId,
        },
        readIntentId: rollbackRead.readIntentId,
        capturedResponseHash: rollbackRead.responseHash,
      }),
      /commerce product image reconcile rollback sentinel/u,
    )
  } finally {
    counters.imageReconcileError = null
  }
  assert.equal(
    counters.imageReconcileCalls.length,
    imageCallsBeforeRollback + 1,
  )
  const rollbackImageCall = counters.imageReconcileCalls.at(-1)
  assert.strictEqual(
    rollbackImageCall.client,
    rollbackImageCall.transactionClient,
  )
  const rollbackEvidence = await pool.query(
    `SELECT
       intent.intent_state,
       intent.staged_run_id::text,
       intent.row_version::text,
       attempt.state AS attempt_state,
       (SELECT count(*)::integer
        FROM operations_commerce_intake_runs run
        WHERE run.organization_id = intent.organization_id
          AND run.integration_account_id = intent.integration_account_id
          AND run.idempotency_key = $2) AS rollback_run_count,
       (SELECT count(*)::integer
        FROM operations_commerce_intake_runs
        WHERE organization_id = $1::uuid) AS runs,
       (SELECT count(*)::integer
        FROM operations_commerce_order_candidates
        WHERE organization_id = $1::uuid) AS candidates,
       (SELECT count(*)::integer
        FROM operations_commerce_order_candidate_lines
        WHERE organization_id = $1::uuid) AS candidate_lines,
       (SELECT count(*)::integer
        FROM operations_commerce_intake_continuations
        WHERE organization_id = $1::uuid) AS continuations
     FROM operations_commerce_intake_read_intents intent
     JOIN operations_commerce_provider_attempts attempt
       ON attempt.organization_id = intent.organization_id
      AND attempt.integration_account_id = intent.integration_account_id
      AND attempt.id = intent.provider_attempt_id
     WHERE intent.organization_id = $1::uuid
       AND intent.id = $3::uuid`,
    [
      ids.organization,
      rollbackRead.idempotencyKey,
      rollbackRead.readIntentId,
    ],
  )
  assert.deepEqual(rollbackEvidence.rows[0], {
    intent_state: 'captured',
    staged_run_id: null,
    row_version: '0',
    attempt_state: 'succeeded',
    rollback_run_count: 0,
    ...stageEffectsBeforeRollback,
  })
  assert.equal(counters.auditEvents, auditEventsBeforeRollback)

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
  const durableOrderHealth = await recoveryPersistence
    .readCommerceOrderReconciliationHealthFromPostgres()
  assert.equal(durableOrderHealth.eligibleAccounts, 1)
  assert.deepEqual(
    JSON.parse(JSON.stringify(durableOrderHealth.providerAccounts)),
    { shopify: 1, faire: 0 },
  )
  assert.equal(durableOrderHealth.resource, 'orders')
  const writtenOrderHeartbeat = await recoveryPersistence
    .recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
      phase: 'completed',
      workerId: 'commerce-staging-postgres-test',
      claimed: 1,
      providerWrites: 0,
    })
  const durableOrderHeartbeat = await recoveryPersistence
    .readCommerceOrderReconciliationWorkerHeartbeatFromPostgres()
  assert.equal(durableOrderHeartbeat.checkedAt, writtenOrderHeartbeat.checkedAt)
  assert.equal(durableOrderHeartbeat.phase, 'completed')
  assert.equal(durableOrderHeartbeat.providerWrites, 0)
  const recoveryTargets = await recoveryPersistence
    .claimCommerceOrderReconciliationTargetsInPostgres({ limit: 1 })
  assert.equal(recoveryTargets.length, 1)
  assert.equal(
    recoveryTargets[0].continuationRunGlobalId,
    continuation.global_id,
  )
  assert.equal(recoveryTargets[0].continuationIdempotencyKey, recoveryKey)
  assert.equal(
    recoveryTargets[0].recordsSeen,
    6,
    'Crash recovery must derive records seen from immutable session pages',
  )
  assert.equal(
    recoveryTargets[0].recordsHeld,
    6,
    'Crash recovery must derive held records from staged session evidence',
  )
  assert.equal(recoveryTargets[0].continuationBatchNumber, 1)
  const competingTargets = await recoveryPersistence
    .claimCommerceOrderReconciliationTargetsInPostgres({ limit: 1 })
  assert.equal(
    competingTargets.length,
    0,
    'A second worker must not steal a live reconciliation lease',
  )

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

  const projectedRecoveryPage = await recoveryPersistence
    .projectCommerceOrderReconciliationPageInPostgres({
      target: recoveryTargets[0],
      runGlobalId: continuation.global_id,
    })
  assert.equal(projectedRecoveryPage.leaseLost, false)
  assert.equal(projectedRecoveryPage.recordsSeen, 6)
  assert.equal(projectedRecoveryPage.recordsHeld, 6)
  assert.equal(projectedRecoveryPage.continuationBatchNumber, 1)
  assert.equal(projectedRecoveryPage.providerCursorRepeated, false)
  assert.ok(
    projectedRecoveryPage.startedAt > recoveryTargets[0].startedAt,
    'Page projection must advance the exact lease token monotonically',
  )
  const staleProjection = await recoveryPersistence
    .projectCommerceOrderReconciliationPageInPostgres({
      target: recoveryTargets[0],
      runGlobalId: continuation.global_id,
    })
  assert.equal(
    staleProjection.leaseLost,
    true,
    'The pre-projection lease owner must lose its stale compare-and-swap',
  )

  const terminalPreparationClient = await pool.connect()
  try {
    await terminalPreparationClient.query(
      'SET session_replication_role = replica',
    )
    await terminalPreparationClient.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, entity_type
       ) VALUES (
         'gia0009201', 'gia', 'gia0009201', 'active',
         'operations.integration_account'
       ) ON CONFLICT (reference_code) DO NOTHING`,
    )
    await terminalPreparationClient.query(
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
        Buffer.from('terminal-cursor'),
        Buffer.alloc(12, 9),
        Buffer.alloc(16, 10),
        cursorHash,
      ],
    )
    await terminalPreparationClient.query(
      `UPDATE operations_commerce_sync_cursors
       SET consecutive_failures = 7
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'`,
      [ids.organization, ids.integrationAccount],
    )
  } finally {
    await terminalPreparationClient.query(
      'SET session_replication_role = origin',
    ).catch(() => {})
    terminalPreparationClient.release()
  }

  const projectedTarget = {
    ...recoveryTargets[0],
    startedAt: projectedRecoveryPage.startedAt,
    recordsSeen: projectedRecoveryPage.recordsSeen,
    recordsHeld: projectedRecoveryPage.recordsHeld,
    continuationBatchNumber:
      projectedRecoveryPage.continuationBatchNumber,
  }
  const terminalFailure = await recoveryPersistence
    .failCommerceOrderReconciliationInPostgres({
      target: projectedTarget,
      error: { code: 'COMMERCE_ORDER_RECONCILIATION_FAILED' },
    })
  assert.equal(terminalFailure.leaseLost, false)
  assert.equal(terminalFailure.terminal, true)
  assert.equal(
    terminalFailure.errorCode,
    'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED',
  )
  assert.equal(terminalFailure.consecutiveFailures, 8)
  assert.equal(terminalFailure.continuationTransition, 'superseded')
  assert.equal(terminalFailure.continuationsRetired, 1)
  const terminalEvidence = await pool.query(
    `SELECT
       cursor.reconciliation_status, cursor.records_seen::text,
       cursor.records_held::text, cursor.consecutive_failures,
       cursor.last_error_code,
       continuation.cursor_state,
       continuation.cursor_ciphertext IS NULL AS cursor_ciphertext_cleared,
       continuation.cursor_hash IS NULL AS cursor_hash_cleared,
       (SELECT count(*)::integer
        FROM audit_events audit
        WHERE audit.organization_id = cursor.organization_id
          AND audit.event_type =
              'commerce.orders.reconciliation.terminal') AS audit_count
     FROM operations_commerce_sync_cursors cursor
     JOIN operations_commerce_intake_continuations continuation
       ON continuation.organization_id = cursor.organization_id
      AND continuation.integration_account_id
          = cursor.integration_account_id
      AND continuation.id = $3::uuid
     WHERE cursor.organization_id = $1::uuid
       AND cursor.integration_account_id = $2::uuid
       AND cursor.resource = 'orders'`,
    [ids.organization, ids.integrationAccount, continuation.id],
  )
  assert.deepEqual(terminalEvidence.rows[0], {
    reconciliation_status: 'failed',
    records_seen: '6',
    records_held: '6',
    consecutive_failures: 8,
    last_error_code: 'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED',
    cursor_state: 'superseded',
    cursor_ciphertext_cleared: true,
    cursor_hash_cleared: true,
    audit_count: 1,
  })

  const resetKey = randomUUID()
  const resetReason = (
    'Acceptance operator reviewed the terminal order read and requested '
    + 'a fresh root session.'
  )
  const resetResult = await recoveryPersistence
    .resetCommerceOrderReconciliationInPostgres({
      organizationId: ids.organization,
      accountGlobalId: 'gia0009201',
      actorEmail,
      idempotencyKey: resetKey,
      expectedLastErrorCode:
        'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED',
      expectedLastStartedAt: projectedRecoveryPage.startedAt,
      reason: resetReason,
      confirmReset: true,
    })
  assert.equal(resetResult.replayed, false)
  assert.equal(resetResult.status, 'idle')
  assert.equal(resetResult.freshRootSession, true)
  assert.equal(resetResult.previousRecordsSeen, 6)
  assert.equal(resetResult.previousRecordsHeld, 6)
  assert.equal(resetResult.previousConsecutiveFailures, 8)
  const resetReplay = await recoveryPersistence
    .resetCommerceOrderReconciliationInPostgres({
      organizationId: ids.organization,
      accountGlobalId: 'gia0009201',
      actorEmail,
      idempotencyKey: resetKey,
      expectedLastErrorCode:
        'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED',
      expectedLastStartedAt: projectedRecoveryPage.startedAt,
      reason: resetReason,
      confirmReset: true,
    })
  assert.equal(resetReplay.replayed, true)
  const resetEvidence = await pool.query(
    `SELECT
       cursor.reconciliation_status, cursor.records_seen::text,
       cursor.records_held::text, cursor.consecutive_failures,
       cursor.last_error_code, cursor.last_started_at,
       receipt.status AS receipt_status, receipt.attempts,
       audit.actor, audit.payload->>'reason' AS reason,
       audit.payload->>'previousErrorCode' AS previous_error_code
     FROM operations_commerce_sync_cursors cursor
     JOIN operations_command_receipts receipt
       ON receipt.organization_id = cursor.organization_id
      AND receipt.command_type =
          'commerce.orders.reconciliation.reset'
      AND receipt.idempotency_key = $3
     JOIN audit_events audit
       ON audit.organization_id = cursor.organization_id
      AND audit.event_type = 'commerce.orders.reconciliation.reset'
     WHERE cursor.organization_id = $1::uuid
       AND cursor.integration_account_id = $2::uuid
       AND cursor.resource = 'orders'`,
    [ids.organization, ids.integrationAccount, resetKey],
  )
  assert.deepEqual(resetEvidence.rows[0], {
    reconciliation_status: 'idle',
    records_seen: '0',
    records_held: '0',
    consecutive_failures: 0,
    last_error_code: null,
    last_started_at: null,
    receipt_status: 'succeeded',
    attempts: 1,
    actor: actorEmail,
    reason: resetReason,
    previous_error_code:
      'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED',
  })
  const freshRootTargets = await recoveryPersistence
    .claimCommerceOrderReconciliationTargetsInPostgres({ limit: 1 })
  assert.equal(freshRootTargets.length, 1)
  assert.equal(freshRootTargets[0].continuationRunGlobalId, null)
  assert.equal(freshRootTargets[0].continuationBatchNumber, null)
  assert.equal(freshRootTargets[0].recordsSeen, 0)
  assert.equal(freshRootTargets[0].recordsHeld, 0)

  await verifyPromotionNumericScaleAcceptance(
    pool,
    ids,
    persistence,
    counters,
  )

  const backlogRead = {
    providerAttemptId: randomUUID(),
    providerAttemptGlobalId: 'gxa000000009203',
    readIntentId: randomUUID(),
    sessionId: randomUUID(),
    idempotencyKey: 'commerce-staging-postgres-customer-backlog',
    responseHash: hash('commerce-staging-customer-backlog-response'),
  }
  const backlogSeed = await pool.connect()
  try {
    await seedAdditionalCapturedRead(backlogSeed, ids, backlogRead)
  } finally {
    backlogSeed.release()
  }
  counters.expectedImageStage = {
    idempotencyKey: backlogRead.idempotencyKey,
    readIntentId: backlogRead.readIntentId,
  }
  const backlogRun = await persistence.stageCommerceNormalizationEnvelopeInPostgres({
    ...stageInput,
    idempotencyKey: backlogRead.idempotencyKey,
    envelope: Object.freeze({
      ...envelope,
      sourceHash: hash('commerce-staging-customer-backlog-envelope'),
    }),
    page: {
      ...stageInput.page,
      sessionId: backlogRead.sessionId,
    },
    readIntentId: backlogRead.readIntentId,
    capturedResponseHash: backlogRead.responseHash,
  })
  const backlogTargets = await persistence
    .readAutomaticCommerceCustomerTargetsForRunInPostgres({
      runtime: stageInput.runtime,
      runGlobalId: backlogRun.runGlobalId,
    })
  const originalTargetIds = new Set(
    automaticCustomerTargets.map((target) => target.candidateGlobalId),
  )
  assert.equal(
    backlogRun.ordersStaged,
    0,
    'An unchanged provider page should not duplicate prior order candidates',
  )
  assert.equal(
    backlogTargets.length,
    4,
    'A no-change intake page must still discover unresolved prior-run candidates',
  )
  assert.equal(
    backlogTargets.filter(
      (target) => originalTargetIds.has(target.candidateGlobalId),
    ).length,
    4,
    'Only still-unresolved prior-run candidates belong in the backlog sweep',
  )
  const previousFairePromotionCohort = process.env
    .CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS
  const previousFairePromotionNotBefore = process.env
    .CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE
  const previousFairePromotionLane = process.env.CLAWPILOT_ENV
  process.env.CLAWPILOT_ENV = 'development'
  process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS =
    'gia0009202'
  process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE =
    new Date(Date.now() - 60_000).toISOString()
  try {
    await verifyAutomaticFaireExactRefreshLineage(
      pool,
      ids,
      persistence,
      counters,
    )
  } finally {
    if (previousFairePromotionCohort === undefined) {
      delete process.env
        .CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS
    } else {
      process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS =
        previousFairePromotionCohort
    }
    if (previousFairePromotionNotBefore === undefined) {
      delete process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE
    } else {
      process.env.CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE =
        previousFairePromotionNotBefore
    }
    if (previousFairePromotionLane === undefined) {
      delete process.env.CLAWPILOT_ENV
    } else {
      process.env.CLAWPILOT_ENV = previousFairePromotionLane
    }
  }
  await verifyFaireExactVariantPackBinding(
    pool,
    ids,
    persistence,
    counters,
    loadSandboxCommerceE2eAuthorization(pool),
  )
  await verifyAutomaticShopifyCleanPromotion(pool, ids, counters)
  await verifyCustomerPrefetchBinding(pool, ids, persistence, counters)
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
      + 'rollback, review-mode terminal catalog recovery, and policy-drift '
      + 'recovery, plus Faire customer pre-fetch binding disposable-PostgreSQL '
      + 'and exact variant-pack evidence, plus Shopify clean-path preflight, '
      + 'zero-dollar subsidized checkout matching, drift fencing, atomic '
      + 'rollback, and durable cross-scan worker attention acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
