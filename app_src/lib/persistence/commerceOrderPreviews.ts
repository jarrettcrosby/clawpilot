import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import type {
  ShopifyOrderPreviewCandidate,
  ShopifyOrderPreviewFetchResult,
  ShopifyOrderPreviewGapCode,
  ShopifyOrderPreviewLine,
} from '@/lib/integrations/shopifyOrderPreview'
import type {
  CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type TimestampValue = string | Date

type PreviewRunRow = {
  id: string
  credential_version: number
  window_end: TimestampValue
  max_orders: number
  orders_seen: number
  orders_staged: number
  more_available: boolean
  granted_scopes: string[]
  canonical_orders_created: number
  shopify_writes: number
  sync_cursor_advanced: boolean
  completed_at: TimestampValue
  expires_at: TimestampValue
}

type PreviewRow = {
  external_order_id: string
  order_name: string
  provider_created_at: TimestampValue
  provider_processed_at: TimestampValue
  provider_updated_at: TimestampValue
  provider_cancelled_at: TimestampValue | null
  provider_closed_at: TimestampValue | null
  test_order: boolean
  source_name: string | null
  financial_status: string | null
  fulfillment_status: string
  fulfillable: boolean
  requires_shipping: boolean
  currency_code: string
  subtotal_amount: string
  shipping_amount: string
  tax_amount: string
  total_amount: string
  line_item_quantity: number
  line_items_truncated: boolean
  normalized_lines: ShopifyOrderPreviewStoredLine[]
  gap_codes: ShopifyOrderPreviewGapCode[]
  diagnostic_state: 'complete' | 'gaps'
  source_hash: string
}

type MappingRow = {
  channel_sku: string
  external_product_id: string | null
  active: boolean
  product_global_id: string
  package_profile_ready: boolean
}

export type ShopifyOrderPreviewStoredLine = ShopifyOrderPreviewLine & {
  mappingStatus: 'inactive' | 'mapped' | 'missing' | 'sku_missing'
  mappedProductGlobalId: string | null
  packageProfileReady: boolean
}

export type ShopifyOrderPreviewOrder = {
  externalOrderId: string
  orderName: string
  providerCreatedAt: string
  providerProcessedAt: string
  providerUpdatedAt: string
  providerCancelledAt: string | null
  providerClosedAt: string | null
  testOrder: boolean
  sourceName: string | null
  financialStatus: string | null
  fulfillmentStatus: string
  fulfillable: boolean
  requiresShipping: boolean
  currencyCode: string
  subtotalAmount: string
  shippingAmount: string
  taxAmount: string
  totalAmount: string
  lineItemQuantity: number
  lineItemsTruncated: boolean
  normalizedLines: ShopifyOrderPreviewStoredLine[]
  gapCodes: ShopifyOrderPreviewGapCode[]
  diagnosticState: 'complete' | 'gaps'
  sourceHash: string
}

export type ShopifyOrderPreviewState = {
  accountGlobalId: string
  status: 'empty' | 'held'
  policy: {
    version: 'shopify-held-preview-v1'
    retentionHours: 24
    maxOrders: 25
    maxLinesPerOrder: 20
    rawPayloadStored: false
    customerFieldsRequested: false
    shopifyWritesAllowed: false
    canonicalPromotionAllowed: false
  }
  run: {
    credentialVersion: number
    windowEnd: string
    ordersSeen: number
    ordersStaged: number
    moreAvailable: boolean
    grantedScopes: string[]
    canonicalOrdersCreated: number
    shopifyWrites: number
    syncCursorAdvanced: boolean
    completedAt: string
    expiresAt: string
  } | null
  orders: ShopifyOrderPreviewOrder[]
  gapCounts: Record<string, number>
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function baseState(accountGlobalId: string): ShopifyOrderPreviewState {
  return {
    accountGlobalId,
    status: 'empty',
    policy: {
      version: 'shopify-held-preview-v1',
      retentionHours: 24,
      maxOrders: 25,
      maxLinesPerOrder: 20,
      rawPayloadStored: false,
      customerFieldsRequested: false,
      shopifyWritesAllowed: false,
      canonicalPromotionAllowed: false,
    },
    run: null,
    orders: [],
    gapCounts: {},
  }
}

function orderState(row: PreviewRow): ShopifyOrderPreviewOrder {
  return {
    externalOrderId: row.external_order_id,
    orderName: row.order_name,
    providerCreatedAt: iso(row.provider_created_at) as string,
    providerProcessedAt: iso(row.provider_processed_at) as string,
    providerUpdatedAt: iso(row.provider_updated_at) as string,
    providerCancelledAt: iso(row.provider_cancelled_at),
    providerClosedAt: iso(row.provider_closed_at),
    testOrder: row.test_order,
    sourceName: row.source_name,
    financialStatus: row.financial_status,
    fulfillmentStatus: row.fulfillment_status,
    fulfillable: row.fulfillable,
    requiresShipping: row.requires_shipping,
    currencyCode: row.currency_code,
    subtotalAmount: row.subtotal_amount,
    shippingAmount: row.shipping_amount,
    taxAmount: row.tax_amount,
    totalAmount: row.total_amount,
    lineItemQuantity: row.line_item_quantity,
    lineItemsTruncated: row.line_items_truncated,
    normalizedLines: row.normalized_lines,
    gapCodes: row.gap_codes,
    diagnosticState: row.diagnostic_state,
    sourceHash: row.source_hash,
  }
}

async function accountId(
  organizationId: string,
  accountGlobalId: string,
): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT id::text
     FROM operations_integration_accounts
     WHERE organization_id = $1::uuid
       AND global_id = $2
       AND integration_type = 'commerce'
       AND provider = 'shopify'
       AND environment = 'sandbox'
     LIMIT 1`,
    [organizationId, accountGlobalId],
  )
  return result.rows[0]?.id || null
}

export async function purgeExpiredShopifyOrderPreviewsInPostgres() {
  const result = await query(
    `DELETE FROM operations_commerce_order_preview_runs
     WHERE expires_at <= now()`,
  )
  return result.rowCount || 0
}

export async function readShopifyOrderPreviewStateFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
}): Promise<ShopifyOrderPreviewState> {
  await purgeExpiredShopifyOrderPreviewsInPostgres()
  const integrationAccountId = await accountId(
    input.organizationId,
    input.accountGlobalId,
  )
  const empty = baseState(input.accountGlobalId)
  if (!integrationAccountId) return empty

  const runResult = await query<PreviewRunRow>(
    `SELECT
       id::text,
       credential_version,
       window_end,
       max_orders,
       orders_seen,
       orders_staged,
       more_available,
       granted_scopes,
       canonical_orders_created,
       shopify_writes,
       sync_cursor_advanced,
       completed_at,
       expires_at
     FROM operations_commerce_order_preview_runs
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND expires_at > now()
     ORDER BY completed_at DESC, id DESC
     LIMIT 1`,
    [input.organizationId, integrationAccountId],
  )
  const run = runResult.rows[0]
  if (!run) return empty
  const previewResult = await query<PreviewRow>(
    `SELECT
       external_order_id,
       order_name,
       provider_created_at,
       provider_processed_at,
       provider_updated_at,
       provider_cancelled_at,
       provider_closed_at,
       test_order,
       source_name,
       financial_status,
       fulfillment_status,
       fulfillable,
       requires_shipping,
       currency_code,
       subtotal_amount::text,
       shipping_amount::text,
       tax_amount::text,
       total_amount::text,
       line_item_quantity,
       line_items_truncated,
       normalized_lines,
       gap_codes,
       diagnostic_state,
       source_hash
     FROM operations_commerce_order_previews
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND run_id = $3::uuid
       AND expires_at > now()
     ORDER BY provider_created_at DESC, external_order_id`,
    [input.organizationId, integrationAccountId, run.id],
  )
  const orders = previewResult.rows.map(orderState)
  const gapCounts: Record<string, number> = {}
  for (const order of orders) {
    for (const gap of order.gapCodes) {
      gapCounts[gap] = (gapCounts[gap] || 0) + 1
    }
  }
  return {
    ...empty,
    status: 'held',
    run: {
      credentialVersion: run.credential_version,
      windowEnd: iso(run.window_end) as string,
      ordersSeen: run.orders_seen,
      ordersStaged: run.orders_staged,
      moreAvailable: run.more_available,
      grantedScopes: run.granted_scopes,
      canonicalOrdersCreated: run.canonical_orders_created,
      shopifyWrites: run.shopify_writes,
      syncCursorAdvanced: run.sync_cursor_advanced,
      completedAt: iso(run.completed_at) as string,
      expiresAt: iso(run.expires_at) as string,
    },
    orders,
    gapCounts,
  }
}

async function mappingCatalog(
  client: PoolClient,
  runtime: CommerceRuntimeCredentialRecord,
  candidates: ShopifyOrderPreviewCandidate[],
) {
  const skus = [...new Set(
    candidates.flatMap((candidate) => (
      candidate.normalizedLines
        .map((line) => line.sku)
        .filter((sku): sku is string => Boolean(sku))
    )),
  )]
  if (!skus.length) return new Map<string, MappingRow>()
  const result = await client.query<MappingRow>(
    `SELECT
       mapping.channel_sku,
       mapping.external_product_id,
       mapping.active,
       product.reference_code AS product_global_id,
       EXISTS (
         SELECT 1
         FROM operations_product_package_profiles profile
         WHERE profile.organization_id = mapping.organization_id
           AND profile.product_id = mapping.product_id
           AND profile.active = true
           AND profile.is_default = true
       ) AS package_profile_ready
     FROM operations_product_mappings mapping
     JOIN crm_products product
       ON product.pipeline_id = mapping.pipeline_id
      AND product.id = mapping.product_id
     WHERE mapping.organization_id = $1::uuid
       AND mapping.integration_account_id = $2::uuid
       AND mapping.channel_sku = ANY($3::text[])`,
    [runtime.organizationId, runtime.integrationAccountId, skus],
  )
  return new Map(result.rows.map((row) => [row.channel_sku, row]))
}

function enrichCandidate(
  candidate: ShopifyOrderPreviewCandidate,
  mappings: Map<string, MappingRow>,
) {
  const gaps = new Set(candidate.gapCodes)
  const normalizedLines: ShopifyOrderPreviewStoredLine[] =
    candidate.normalizedLines.map((line) => {
      const mapping = line.sku ? mappings.get(line.sku) : undefined
      if (!line.sku) {
        gaps.add('sku_missing')
        return {
          ...line,
          mappingStatus: 'sku_missing',
          mappedProductGlobalId: null,
          packageProfileReady: false,
        }
      }
      if (!mapping) {
        gaps.add('product_mapping_missing')
        return {
          ...line,
          mappingStatus: 'missing',
          mappedProductGlobalId: null,
          packageProfileReady: false,
        }
      }
      if (!mapping.active) {
        gaps.add('product_mapping_inactive')
        return {
          ...line,
          mappingStatus: 'inactive',
          mappedProductGlobalId: mapping.product_global_id,
          packageProfileReady: false,
        }
      }
      if (!mapping.package_profile_ready) gaps.add('package_profile_missing')
      return {
        ...line,
        mappingStatus: 'mapped',
        mappedProductGlobalId: mapping.product_global_id,
        packageProfileReady: mapping.package_profile_ready,
      }
    })
  return {
    ...candidate,
    normalizedLines,
    gapCodes: [...gaps].sort(),
  }
}

export async function storeShopifyOrderPreviewInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  idempotencyKey: string
  requestHash: string
  grantedScopes: string[]
  fetched: ShopifyOrderPreviewFetchResult
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-preview:${input.runtime.organizationId}:${input.runtime.globalId}`,
    )
    await client.query(
      `DELETE FROM operations_commerce_order_preview_runs
       WHERE expires_at <= now()`,
    )
    const fence = await client.query<{
      environment: string
      verification_status: string
      credential_version: number
    }>(
      `SELECT
         account.environment,
         credential.verification_status,
         credential.credential_version
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.global_id = $3
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
         AND account.commerce_credential_generation = $4
       FOR UPDATE OF account, credential`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.runtime.globalId,
        input.runtime.credentialVersion,
      ],
    )
    const current = fence.rows[0]
    if (
      !current
      || current.environment !== 'sandbox'
      || current.verification_status !== 'verified'
      || current.credential_version !== input.runtime.credentialVersion
    ) {
      throw new Error(
        'Shopify order preview credential changed before preview commit',
      )
    }
    const existing = await client.query<{
      id: string
      request_hash: string
    }>(
      `SELECT id::text, request_hash
       FROM operations_commerce_order_preview_runs
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = $3::uuid
       LIMIT 1`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.idempotencyKey,
      ],
    )
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== input.requestHash) {
        throw new Error(
          'Shopify order preview idempotency key was reused for a different request',
        )
      }
      return
    }
    const mappings = await mappingCatalog(
      client,
      input.runtime,
      input.fetched.candidates,
    )
    const candidates = input.fetched.candidates.map((candidate) => (
      enrichCandidate(candidate, mappings)
    ))
    await client.query(
      `DELETE FROM operations_commerce_order_preview_runs
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ],
    )
    const runResult = await client.query<{
      id: string
      expires_at: TimestampValue
    }>(
      `INSERT INTO operations_commerce_order_preview_runs (
         organization_id,
         integration_account_id,
         credential_version,
         idempotency_key,
         request_hash,
         window_end,
         max_orders,
         orders_seen,
         orders_staged,
         more_available,
         granted_scopes,
         created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5, $6::timestamptz,
         25, $7, $8, $9, $10::text[], $11
       )
       RETURNING id::text, expires_at`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.runtime.credentialVersion,
        input.idempotencyKey,
        input.requestHash,
        input.fetched.windowEnd,
        input.fetched.ordersSeen,
        candidates.length,
        input.fetched.moreAvailable,
        input.grantedScopes,
        input.actorEmail,
      ],
    )
    const run = runResult.rows[0]
    for (const candidate of candidates) {
      await client.query(
        `INSERT INTO operations_commerce_order_previews (
           organization_id,
           integration_account_id,
           run_id,
           external_order_id,
           order_name,
           provider_created_at,
           provider_processed_at,
           provider_updated_at,
           provider_cancelled_at,
           provider_closed_at,
           test_order,
           source_name,
           financial_status,
           fulfillment_status,
           fulfillable,
           requires_shipping,
           currency_code,
           subtotal_amount,
           shipping_amount,
           tax_amount,
           total_amount,
           line_item_quantity,
           line_items_truncated,
           normalized_lines,
           gap_codes,
           diagnostic_state,
           source_hash,
           expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5,
           $6::timestamptz, $7::timestamptz, $8::timestamptz,
           $9::timestamptz, $10::timestamptz, $11, $12, $13, $14,
           $15, $16, $17, $18::numeric, $19::numeric, $20::numeric,
           $21::numeric, $22, $23, $24::jsonb, $25::text[], $26, $27,
           $28::timestamptz
         )`,
        [
          input.runtime.organizationId,
          input.runtime.integrationAccountId,
          run.id,
          candidate.externalOrderId,
          candidate.orderName,
          candidate.providerCreatedAt,
          candidate.providerProcessedAt,
          candidate.providerUpdatedAt,
          candidate.providerCancelledAt,
          candidate.providerClosedAt,
          candidate.testOrder,
          candidate.sourceName,
          candidate.financialStatus,
          candidate.fulfillmentStatus,
          candidate.fulfillable,
          candidate.requiresShipping,
          candidate.currencyCode,
          candidate.subtotalAmount,
          candidate.shippingAmount,
          candidate.taxAmount,
          candidate.totalAmount,
          candidate.lineItemQuantity,
          candidate.lineItemsTruncated,
          JSON.stringify(candidate.normalizedLines),
          candidate.gapCodes,
          candidate.gapCodes.length ? 'gaps' : 'complete',
          candidate.sourceHash,
          iso(run.expires_at),
        ],
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.shopify_order_preview.imported',
      aggregateType: 'commerce_integration',
      aggregateId: input.runtime.globalId,
      organizationId: input.runtime.organizationId,
      payload: {
        policyVersion: 'shopify-held-preview-v1',
        credentialVersion: input.runtime.credentialVersion,
        ordersSeen: input.fetched.ordersSeen,
        ordersStaged: candidates.length,
        moreAvailable: input.fetched.moreAvailable,
        canonicalOrdersCreated: 0,
        shopifyWrites: 0,
        syncCursorAdvanced: false,
      },
    }, client)
  })
  return readShopifyOrderPreviewStateFromPostgres({
    organizationId: input.runtime.organizationId,
    accountGlobalId: input.runtime.globalId,
  })
}

export async function clearShopifyOrderPreviewInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  actorEmail: string
}) {
  const deleted = await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-preview:${input.runtime.organizationId}:${input.runtime.globalId}`,
    )
    const result = await client.query(
      `DELETE FROM operations_commerce_order_preview_runs
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.shopify_order_preview.cleared',
      aggregateType: 'commerce_integration',
      aggregateId: input.runtime.globalId,
      organizationId: input.runtime.organizationId,
      payload: {
        previewRunsDeleted: result.rowCount || 0,
      },
    }, client)
    return result.rowCount || 0
  })
  return {
    deleted,
    state: await readShopifyOrderPreviewStateFromPostgres({
      organizationId: input.runtime.organizationId,
      accountGlobalId: input.runtime.globalId,
    }),
  }
}
