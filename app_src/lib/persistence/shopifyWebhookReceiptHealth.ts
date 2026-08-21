import { query } from '@/lib/persistence/postgres'

type TimestampValue = string | Date

type ShopifyWebhookReceiptHealthRow = {
  integration_account_id?: string
  account_global_id?: string
  accounts?: string | number
  actionable_accounts?: string | number
  actionable: string | number
  stale_queued: string | number
  stale_processing: string | number
  failed: string | number
  dead_letter: string | number
  held_product_deletes: string | number
  oldest_actionable_at: TimestampValue | null
}

export type ShopifyWebhookReceiptHealth = {
  status: 'ready' | 'attention'
  accounts: number
  actionableAccounts: number
  actionable: number
  staleQueued: number
  staleProcessing: number
  failed: number
  deadLetter: number
  heldProductDeletes: number
  oldestActionableAt: string | null
}

export type ShopifyWebhookReceiptAccountHealth = Omit<
  ShopifyWebhookReceiptHealth,
  'accounts' | 'actionableAccounts'
> & {
  integrationAccountId: string
  accountGlobalId: string
}

const ACTIONABLE_CLASSIFICATIONS = [
  'stale_queued',
  'stale_processing',
  'failed',
  'dead_letter',
  'held_product_delete',
] as const

function shopifyWebhookReceiptClassificationCtes(
  accountPredicate: string,
) {
  return `
WITH current_shopify_accounts AS (
  SELECT
    account.organization_id,
    account.id AS integration_account_id,
    account.global_id AS account_global_id,
    account.status,
    account.receipt_intake_enabled,
    account.external_account_id AS account_external_account_id,
    account.commerce_credential_generation,
    credential.external_account_id AS credential_external_account_id,
    credential.auth_mode,
    credential.verification_status,
    credential.webhook_verification_status,
    activation.state AS activation_state,
    operations_commerce_store_sync_is_running(
      account.organization_id,
      account.id
    ) AS store_sync_running,
    COALESCE(
      account.updated_by,
      account.created_by,
      credential.updated_by,
      credential.created_by
    ) AS actor_email
  FROM operations_integration_accounts account
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
   AND credential.credential_version =
       account.commerce_credential_generation
  LEFT JOIN operations_activation_scopes activation
    ON activation.organization_id = account.organization_id
  WHERE account.integration_type = 'commerce'
    AND account.provider = 'shopify'
    ${accountPredicate}
), classified_receipts AS (
  SELECT
    account.organization_id,
    account.integration_account_id,
    account.account_global_id,
    receipt.received_at,
    CASE
      WHEN NOT account.store_sync_running THEN 'informational'
      WHEN receipt.state = 'queued'
       AND receipt.received_at <= clock_timestamp() - interval '2 minutes'
        THEN 'stale_queued'
      WHEN receipt.state = 'processing'
       AND (
         receipt.lease_expires_at IS NULL
         OR receipt.lease_expires_at <= clock_timestamp()
       )
        THEN 'stale_processing'
      WHEN receipt.state = 'failed' THEN 'failed'
      WHEN receipt.state = 'dead_letter' THEN 'dead_letter'
      WHEN receipt.state = 'held'
       AND receipt.topic = 'products/delete'
       AND receipt.attempts < receipt.max_attempts
       AND account.status = 'active'
       AND account.receipt_intake_enabled = true
       AND account.credential_external_account_id =
           account.account_external_account_id
       AND account.auth_mode = 'shopify_client_credentials'
       AND account.verification_status = 'verified'
       AND account.webhook_verification_status = 'verified'
       AND account.store_sync_running
       AND account.actor_email IS NOT NULL
        THEN 'held_product_delete'
      ELSE 'informational'
    END AS classification
  FROM current_shopify_accounts account
  JOIN operations_commerce_webhook_receipts receipt
    ON receipt.organization_id = account.organization_id
   AND receipt.integration_account_id = account.integration_account_id
   AND receipt.provider = 'shopify'
   AND receipt.credential_version =
       account.commerce_credential_generation
   AND (
     receipt.state IN ('queued', 'processing', 'failed', 'dead_letter')
     OR (
       receipt.state = 'held'
       AND receipt.topic = 'products/delete'
     )
   )
)
`.trim()
}

export const SHOPIFY_WEBHOOK_RECEIPT_CLASSIFICATION_CTES =
  shopifyWebhookReceiptClassificationCtes('')

export const SHOPIFY_WEBHOOK_RECEIPT_ACCOUNT_CLASSIFICATION_CTES =
  shopifyWebhookReceiptClassificationCtes(
    'AND account.organization_id = $1::uuid',
  )

const actionableSql = ACTIONABLE_CLASSIFICATIONS
  .map((classification) => `'${classification}'`)
  .join(', ')

export const SHOPIFY_WEBHOOK_RECEIPT_HEALTH_QUERY = `
${SHOPIFY_WEBHOOK_RECEIPT_CLASSIFICATION_CTES}
SELECT
  count(DISTINCT account.integration_account_id)::text AS accounts,
  count(DISTINCT account.integration_account_id) FILTER (
    WHERE EXISTS (
      SELECT 1
      FROM classified_receipts receipt
      WHERE receipt.organization_id = account.organization_id
        AND receipt.integration_account_id = account.integration_account_id
        AND receipt.classification IN (${actionableSql})
    )
  )::text AS actionable_accounts,
  count(receipt.classification) FILTER (
    WHERE receipt.classification IN (${actionableSql})
  )::text AS actionable,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'stale_queued'
  )::text AS stale_queued,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'stale_processing'
  )::text AS stale_processing,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'failed'
  )::text AS failed,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'dead_letter'
  )::text AS dead_letter,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'held_product_delete'
  )::text AS held_product_deletes,
  min(receipt.received_at) FILTER (
    WHERE receipt.classification IN (${actionableSql})
  ) AS oldest_actionable_at
FROM current_shopify_accounts account
LEFT JOIN classified_receipts receipt
  ON receipt.organization_id = account.organization_id
 AND receipt.integration_account_id = account.integration_account_id
`

export const SHOPIFY_WEBHOOK_RECEIPT_ACCOUNT_HEALTH_QUERY = `
${SHOPIFY_WEBHOOK_RECEIPT_ACCOUNT_CLASSIFICATION_CTES}
SELECT
  account.integration_account_id::text,
  account.account_global_id,
  count(receipt.classification) FILTER (
    WHERE receipt.classification IN (${actionableSql})
  )::text AS actionable,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'stale_queued'
  )::text AS stale_queued,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'stale_processing'
  )::text AS stale_processing,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'failed'
  )::text AS failed,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'dead_letter'
  )::text AS dead_letter,
  count(receipt.classification) FILTER (
    WHERE receipt.classification = 'held_product_delete'
  )::text AS held_product_deletes,
  min(receipt.received_at) FILTER (
    WHERE receipt.classification IN (${actionableSql})
  ) AS oldest_actionable_at
FROM current_shopify_accounts account
LEFT JOIN classified_receipts receipt
  ON receipt.organization_id = account.organization_id
 AND receipt.integration_account_id = account.integration_account_id
WHERE account.organization_id = $1::uuid
GROUP BY account.integration_account_id, account.account_global_id
ORDER BY account.account_global_id
`

function count(value: string | number | undefined) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function iso(value: TimestampValue | null | undefined) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function accountHealth(
  row: ShopifyWebhookReceiptHealthRow,
): ShopifyWebhookReceiptAccountHealth {
  const actionable = count(row.actionable)
  return {
    integrationAccountId: String(row.integration_account_id || ''),
    accountGlobalId: String(row.account_global_id || ''),
    status: actionable > 0 ? 'attention' : 'ready',
    actionable,
    staleQueued: count(row.stale_queued),
    staleProcessing: count(row.stale_processing),
    failed: count(row.failed),
    deadLetter: count(row.dead_letter),
    heldProductDeletes: count(row.held_product_deletes),
    oldestActionableAt: iso(row.oldest_actionable_at),
  }
}

export async function readShopifyWebhookReceiptHealthFromPostgres(): Promise<
  ShopifyWebhookReceiptHealth
> {
  const result = await query<ShopifyWebhookReceiptHealthRow>(
    SHOPIFY_WEBHOOK_RECEIPT_HEALTH_QUERY,
  )
  const row = result.rows[0] || {}
  const actionable = count(row.actionable)
  return {
    status: actionable > 0 ? 'attention' : 'ready',
    accounts: count(row.accounts),
    actionableAccounts: count(row.actionable_accounts),
    actionable,
    staleQueued: count(row.stale_queued),
    staleProcessing: count(row.stale_processing),
    failed: count(row.failed),
    deadLetter: count(row.dead_letter),
    heldProductDeletes: count(row.held_product_deletes),
    oldestActionableAt: iso(row.oldest_actionable_at),
  }
}

export async function readShopifyWebhookReceiptAccountHealthFromPostgres(
  organizationId: string,
): Promise<ShopifyWebhookReceiptAccountHealth[]> {
  const result = await query<ShopifyWebhookReceiptHealthRow>(
    SHOPIFY_WEBHOOK_RECEIPT_ACCOUNT_HEALTH_QUERY,
    [organizationId],
  )
  return result.rows.map(accountHealth)
}
