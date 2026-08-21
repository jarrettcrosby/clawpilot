export type ShopifyOrderWebhookRecoveryDraft = Readonly<{
  confirmation: string
  idempotencyKey: string
}>

type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const ORGANIZATION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u

function storageKey(organizationId: string, accountGlobalId: string) {
  if (
    !ORGANIZATION_ID.test(organizationId)
    || !ACCOUNT_GLOBAL_ID.test(accountGlobalId)
  ) return null
  return `clawpilot:shopify-order-webhooks:v1:${organizationId}:${accountGlobalId}`
}

export function saveShopifyOrderWebhookRecoveryDraft(
  storage: SessionStorage,
  input: {
    organizationId: string
    accountGlobalId: string
    confirmation: string
    idempotencyKey: string
  },
) {
  const key = storageKey(input.organizationId, input.accountGlobalId)
  const expected = `RECONCILE 7 ORDER WEBHOOKS FOR ${input.accountGlobalId}`
  if (
    !key
    || input.confirmation !== expected
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) return false
  storage.setItem(key, JSON.stringify({
    schema: 'shopify-order-webhook-recovery-v1',
    confirmation: input.confirmation,
    idempotencyKey: input.idempotencyKey,
  }))
  return true
}

export function loadShopifyOrderWebhookRecoveryDraft(
  storage: SessionStorage,
  input: { organizationId: string; accountGlobalId: string },
): ShopifyOrderWebhookRecoveryDraft | null {
  const key = storageKey(input.organizationId, input.accountGlobalId)
  if (!key) return null
  try {
    const parsed = JSON.parse(storage.getItem(key) || 'null') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const value = parsed as Record<string, unknown>
    const expected = `RECONCILE 7 ORDER WEBHOOKS FOR ${input.accountGlobalId}`
    if (
      value.schema !== 'shopify-order-webhook-recovery-v1'
      || value.confirmation !== expected
      || typeof value.idempotencyKey !== 'string'
      || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
      || Object.keys(value).some((field) => ![
        'schema', 'confirmation', 'idempotencyKey',
      ].includes(field))
    ) return null
    return Object.freeze({
      confirmation: expected,
      idempotencyKey: value.idempotencyKey,
    })
  } catch {
    return null
  }
}

export function clearShopifyOrderWebhookRecoveryDraft(
  storage: SessionStorage,
  input: { organizationId: string; accountGlobalId: string },
) {
  const key = storageKey(input.organizationId, input.accountGlobalId)
  if (!key) return false
  storage.removeItem(key)
  return true
}
