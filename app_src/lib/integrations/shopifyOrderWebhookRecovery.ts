export type ShopifyOrderWebhookRecoveryDraft = Readonly<{
  confirmation: string
  idempotencyKey: string
}>

export const SHOPIFY_ORDER_WEBHOOK_RECOVERY_TOPICS = Object.freeze([
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
  'orders/paid',
  'orders/fulfilled',
  'orders/partially_fulfilled',
])

export const SHOPIFY_ORDER_WEBHOOK_RECOVERY_FIELDS = Object.freeze([
  'admin_graphql_api_id',
  'updated_at',
])

export type ShopifyOrderWebhookRecoveryIdentity = Readonly<{
  organizationId: string
  accountGlobalId: string
  credentialGeneration: number
  callbackUri: string
}>

export type ShopifyOrderWebhookRecoveryHttpResult = Readonly<{
  status: number | null
  code: string | null
  message: string
  payload: unknown
  transportError: boolean
  malformed: boolean
}>

export type ShopifyOrderWebhookRecoveryDecision = Readonly<{
  disposition: 'succeeded' | 'retain' | 'rejected'
  payload: unknown | null
  message: string
  code: string
}>

type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const ORGANIZATION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u

export function isShopifyOrderWebhookRecoveryKey(value: unknown) {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value)
}

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
    || !isShopifyOrderWebhookRecoveryKey(input.idempotencyKey)
  ) return false
  try {
    storage.setItem(key, JSON.stringify({
      schema: 'shopify-order-webhook-recovery-v1',
      confirmation: input.confirmation,
      idempotencyKey: input.idempotencyKey,
    }))
    return true
  } catch {
    return false
  }
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
      || !isShopifyOrderWebhookRecoveryKey(value.idempotencyKey)
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
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

function exactStringArray(value: unknown, expected: readonly string[]) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
}

/**
 * A PATCH response is never sufficient proof of success. This accepts only a
 * fresh workspace projection bound to the exact organization, account,
 * credential generation, callback and complete seven-topic/two-field profile.
 */
export function hasExactShopifyOrderWebhookRecoveryReadiness(
  payload: unknown,
  identity: ShopifyOrderWebhookRecoveryIdentity,
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }
  const root = payload as Record<string, unknown>
  if (root.ok !== true) return false
  const integrations = root.integrations
  if (
    !integrations
    || typeof integrations !== 'object'
    || Array.isArray(integrations)
  ) return false
  const workspace = integrations as Record<string, unknown>
  if (
    workspace.organizationId !== identity.organizationId
    || !Array.isArray(workspace.accounts)
  ) return false
  const matches = workspace.accounts.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return false
    }
    return (candidate as Record<string, unknown>).globalId
      === identity.accountGlobalId
  }) as Record<string, unknown>[]
  if (matches.length !== 1) return false
  const account = matches[0]
  if (
    account.provider !== 'shopify'
    || account.status !== 'active'
    || account.configured !== true
    || account.verificationStatus !== 'verified'
    || account.credentialVersion !== identity.credentialGeneration
    || account.webhookUrl !== identity.callbackUri
  ) return false
  const configuration = account.configuration
  if (
    !configuration
    || typeof configuration !== 'object'
    || Array.isArray(configuration)
  ) return false
  const readiness = (configuration as Record<string, unknown>)
    .orderWebhookSubscriptions
  if (!readiness || typeof readiness !== 'object' || Array.isArray(readiness)) {
    return false
  }
  const state = readiness as Record<string, unknown>
  const observedAt = typeof state.observedAt === 'string'
    ? Date.parse(state.observedAt)
    : Number.NaN
  const evidenceIsCurrent = Number.isFinite(observedAt)
    && observedAt >= Date.now() - 24 * 60 * 60 * 1_000
    && observedAt <= Date.now() + 5 * 60 * 1_000
  return state.accountGlobalId === identity.accountGlobalId
    && state.credentialGeneration === identity.credentialGeneration
    && state.desiredUri === identity.callbackUri
    && exactStringArray(
      state.requiredTopics,
      SHOPIFY_ORDER_WEBHOOK_RECOVERY_TOPICS,
    )
    && exactStringArray(
      state.requiredIncludeFields,
      SHOPIFY_ORDER_WEBHOOK_RECOVERY_FIELDS,
    )
    && state.observedCount === 7
    && state.matchingCount === 7
    && exactStringArray(state.missingTopics, [])
    && exactStringArray(state.conflictingTopics, [])
    && state.subscriptionReady === true
    && state.processorState === 'available'
    && state.exactReadProcessorReady === true
    && state.scheduledPollBackstop === true
    && state.discoveryState === 'succeeded'
    && state.discoveryErrorCode === null
    && state.providerWrites === 0
    && evidenceIsCurrent
    && state.ready === true
}

const RETAINED_CODES = new Set([
  'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_IN_PROGRESS',
  'SHOPIFY_ORDER_WEBHOOK_OUTCOME_UNKNOWN',
  'SHOPIFY_ORDER_WEBHOOK_MUTATION_REJECTED',
])

export function shouldRetainShopifyOrderWebhookRecoveryKey(
  result: ShopifyOrderWebhookRecoveryHttpResult,
) {
  if (result.transportError || result.malformed) return true
  if (result.code && RETAINED_CODES.has(result.code)) return true
  return result.status === 408
    || result.status === 425
    || result.status === 429
    || (result.status !== null && result.status >= 500)
}

/**
 * Runs the browser recovery contract without owning fetch or storage. Every
 * outcome reloads current state. Ambiguous failures keep the byte-identical
 * request key unless that fresh read proves the exact bound profile ready;
 * definitive non-applied 4xx responses are released for explicit review.
 */
export async function resolveShopifyOrderWebhookRecovery(
  input: {
    identity: ShopifyOrderWebhookRecoveryIdentity
    patch: () => Promise<ShopifyOrderWebhookRecoveryHttpResult>
    refresh: () => Promise<unknown>
  },
): Promise<ShopifyOrderWebhookRecoveryDecision> {
  let patch: ShopifyOrderWebhookRecoveryHttpResult
  try {
    patch = await input.patch()
  } catch (error) {
    patch = {
      status: null,
      code: null,
      message: error instanceof Error
        ? error.message
        : 'The reconciliation response was lost.',
      payload: null,
      transportError: true,
      malformed: false,
    }
  }
  let refreshed: unknown = null
  try {
    refreshed = await input.refresh()
  } catch {
    // The PATCH result still determines whether the exact key is retained.
  }
  const responseWasSuccessful = patch.status !== null
    && patch.status >= 200
    && patch.status < 300
    && !patch.malformed
    && (patch.payload as { ok?: unknown } | null)?.ok === true
  const retainKey = shouldRetainShopifyOrderWebhookRecoveryKey(patch)
  if (!responseWasSuccessful && !retainKey) {
    return Object.freeze({
      disposition: 'rejected',
      payload: refreshed,
      message: patch.message,
      code: patch.code || 'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_REJECTED',
    })
  }
  if (patch.code && RETAINED_CODES.has(patch.code)) {
    return Object.freeze({
      disposition: 'retain',
      payload: refreshed,
      message: patch.message,
      code: patch.code,
    })
  }
  if (
    hasExactShopifyOrderWebhookRecoveryReadiness(
      refreshed,
      input.identity,
    )
  ) {
    return Object.freeze({
      disposition: 'succeeded',
      payload: refreshed,
      message: 'Shopify order webhooks are exactly ready.',
      code: 'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_READY',
    })
  }
  if (responseWasSuccessful || retainKey) {
    return Object.freeze({
      disposition: 'retain',
      payload: refreshed,
      message: responseWasSuccessful
        ? 'The write response was accepted, but a fresh read did not prove the exact bound seven-topic profile. Retry only with the retained key after reviewing current state.'
        : patch.message,
      code: patch.code || 'SHOPIFY_ORDER_WEBHOOK_RESPONSE_AMBIGUOUS',
    })
  }
  return Object.freeze({
    disposition: 'rejected',
    payload: refreshed,
    message: patch.message,
    code: patch.code || 'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_REJECTED',
  })
}
