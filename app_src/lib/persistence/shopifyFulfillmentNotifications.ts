import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

export const SHOPIFY_FULFILLMENT_NOTIFICATION_POLICY_VERSION =
  'shopify-fulfillment-notification-v1'

export type ShopifyFulfillmentNotificationPolicyState = {
  mode: 'clawpilot_explicit'
  notifyCustomerDefault: boolean
  revision: number
  changeReason: string
  updatedAt: string
}

type PolicyRow = QueryResultRow & {
  notify_customer_default: boolean
  revision: string | number
  change_reason: string
  updated_at: Date | string
}

export class ShopifyFulfillmentNotificationPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ShopifyFulfillmentNotificationPolicyError'
  }
}

export function shopifyFulfillmentNotificationPolicyLockKey(
  organizationId: string,
  integrationAccountId: string,
) {
  return [
    'commerce',
    'shopify-fulfillment-notification-policy',
    organizationId,
    integrationAccountId,
  ].join(':')
}

function state(row: PolicyRow): ShopifyFulfillmentNotificationPolicyState {
  return {
    mode: 'clawpilot_explicit',
    notifyCustomerDefault: row.notify_customer_default,
    revision: Number(row.revision),
    changeReason: row.change_reason,
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export async function ensureShopifyFulfillmentNotificationPolicyWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    actorEmail: string
  },
) {
  await client.query(
    `INSERT INTO operations_shopify_fulfillment_notification_policies (
       organization_id, integration_account_id, policy_version,
       notify_customer_default, revision, change_reason, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, false, 1,
       'Safe default established when Shopify was connected', $4, $4
     )
     ON CONFLICT (organization_id, integration_account_id) DO NOTHING`,
    [
      input.organizationId,
      input.integrationAccountId,
      SHOPIFY_FULFILLMENT_NOTIFICATION_POLICY_VERSION,
      input.actorEmail,
    ],
  )
}

export async function updateShopifyFulfillmentNotificationPolicyInPostgres(
  input: {
    organizationId: string
    accountGlobalId: string
    actorEmail: string
    expectedRevision: number
    notifyCustomerDefault: boolean
    reason: string
  },
): Promise<ShopifyFulfillmentNotificationPolicyState> {
  return withTransaction(async (client) => {
    const accountResult = await client.query<{
      id: string
      global_id: string
      provider: string
      environment: string
    }>(
      `SELECT id::text, global_id, provider, environment
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND integration_type = 'commerce'
       LIMIT 1
       FOR UPDATE`,
      [input.organizationId, input.accountGlobalId],
    )
    const account = accountResult.rows[0]
    if (!account) {
      throw new ShopifyFulfillmentNotificationPolicyError(
        'SHOPIFY_FULFILLMENT_NOTIFICATION_ACCOUNT_NOT_FOUND',
        'The selected Shopify connection is unavailable',
        404,
      )
    }
    if (account.provider !== 'shopify') {
      throw new ShopifyFulfillmentNotificationPolicyError(
        'SHOPIFY_FULFILLMENT_NOTIFICATION_PROVIDER_INVALID',
        'Faire retailer notifications are provider-managed and cannot be changed in ClawPilot',
        409,
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      shopifyFulfillmentNotificationPolicyLockKey(
        input.organizationId,
        account.id,
      ),
    )
    const currentResult = await client.query<PolicyRow>(
      `SELECT notify_customer_default, revision::text, change_reason, updated_at
       FROM operations_shopify_fulfillment_notification_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
       FOR UPDATE`,
      [input.organizationId, account.id],
    )
    const current = currentResult.rows[0] || null
    const currentRevision = current ? Number(current.revision) : 0
    const currentDefault = current?.notify_customer_default === true
    if (
      !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0
      || input.expectedRevision !== currentRevision
    ) {
      throw new ShopifyFulfillmentNotificationPolicyError(
        'SHOPIFY_FULFILLMENT_NOTIFICATION_REVISION_CONFLICT',
        'The Shopify fulfillment notification policy changed. Reload before saving it again.',
        409,
      )
    }
    if (currentDefault === input.notifyCustomerDefault) {
      throw new ShopifyFulfillmentNotificationPolicyError(
        'SHOPIFY_FULFILLMENT_NOTIFICATION_UNCHANGED',
        'The Shopify fulfillment notification default is already set to that value',
        409,
      )
    }
    const nextRevision = currentRevision + 1
    const updatedResult = await client.query<PolicyRow>(
      `INSERT INTO operations_shopify_fulfillment_notification_policies (
         organization_id, integration_account_id, policy_version,
         notify_customer_default, revision, change_reason, created_by, updated_by
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (organization_id, integration_account_id)
       DO UPDATE SET
         policy_version = EXCLUDED.policy_version,
         notify_customer_default = EXCLUDED.notify_customer_default,
         revision = EXCLUDED.revision,
         change_reason = EXCLUDED.change_reason,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING notify_customer_default, revision::text, change_reason, updated_at`,
      [
        input.organizationId,
        account.id,
        SHOPIFY_FULFILLMENT_NOTIFICATION_POLICY_VERSION,
        input.notifyCustomerDefault,
        nextRevision,
        input.reason,
        input.actorEmail,
      ],
    )
    const updated = state(updatedResult.rows[0])
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.shopify.fulfillment_notification_policy.updated',
      aggregateType: 'commerce_integration',
      aggregateId: account.global_id,
      subject: `Shopify fulfillment notifications for ${account.global_id}`,
      organizationId: input.organizationId,
      eventKey: [
        'commerce',
        'shopify-fulfillment-notification-policy',
        account.global_id,
        nextRevision,
      ].join(':'),
      payload: {
        provider: 'shopify',
        environment: account.environment,
        policyVersion: SHOPIFY_FULFILLMENT_NOTIFICATION_POLICY_VERSION,
        previousNotifyCustomerDefault: currentDefault,
        notifyCustomerDefault: updated.notifyCustomerDefault,
        previousRevision: currentRevision,
        revision: updated.revision,
        reason: input.reason,
      },
    }, client)
    return updated
  })
}
