import { createHash } from 'node:crypto'
import {
  shopifyAdminGraphql,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'

export const SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
  'orders/paid',
  'orders/fulfilled',
  'orders/partially_fulfilled',
] as const

export type ShopifyOrderSignalWebhookTopic =
  typeof SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS[number]

export const SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS = [
  'admin_graphql_api_id',
  'updated_at',
] as const

export const SHOPIFY_ORDER_SIGNAL_MAX_BYTES = 4 * 1024
export const SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS = 24 * 60 * 60

const TOPIC_SET = new Set<string>(SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS)
const REQUIRED_PAYLOAD_KEY_SET = new Set<string>(
  SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS,
)
const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,20}$/u

const SHOPIFY_ORDER_TOPIC_ENUMS: Record<
  ShopifyOrderSignalWebhookTopic,
  string
> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'orders/edited': 'ORDERS_EDITED',
  'orders/cancelled': 'ORDERS_CANCELLED',
  'orders/paid': 'ORDERS_PAID',
  'orders/fulfilled': 'ORDERS_FULFILLED',
  'orders/partially_fulfilled': 'ORDERS_PARTIALLY_FULFILLED',
}

export const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_VERSION =
  'shopify-order-webhooks-reconcile-v1' as const

export function shopifyOrderWebhookReconciliationConfirmation(
  accountGlobalId: string,
) {
  if (!/^gia(?:[0-9]{7}|[0-9a-v]{12})$/u.test(accountGlobalId)) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_ACCOUNT_INVALID',
      'A valid Shopify account is required',
    )
  }
  return `RECONCILE 7 ORDER WEBHOOKS FOR ${accountGlobalId}`
}

export function shopifyOrderWebhookReconciliationRequestHash(input: {
  organizationId: string
  accountGlobalId: string
  integrationAccountId: string
  credentialGeneration: number
  externalAccountId: string
  shopDomain: string
  desiredUri: string
  actorEmail: string
}) {
  return createHash('sha256').update(JSON.stringify({
    schema: SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_VERSION,
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    integrationAccountId: input.integrationAccountId,
    credentialGeneration: input.credentialGeneration,
    externalAccountId: input.externalAccountId,
    shopDomain: input.shopDomain,
    desiredUri: exactHttpsUri(input.desiredUri),
    topics: [...SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS],
    format: 'JSON',
    includeFields: [...SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS],
    actorEmail: input.actorEmail,
  })).digest('hex')
}

export type ShopifyOrderWebhookSignalEvidence = Readonly<{
  topic: ShopifyOrderSignalWebhookTopic
  externalOrderId: string
  providerUpdatedAt: string
  payloadHash: string
  payloadBytes: number
}>

export type ShopifyOrderWebhookSubscriptionObservation = Readonly<{
  providerId: string
  topic: ShopifyOrderSignalWebhookTopic
  uri: string
  format: 'JSON' | 'XML'
  includeFields: string[]
  exactProfile: boolean
}>

export type ShopifyOrderWebhookSubscriptionReadiness = Readonly<{
  desiredUri: string
  requiredTopics: ShopifyOrderSignalWebhookTopic[]
  requiredIncludeFields: string[]
  subscriptions: ShopifyOrderWebhookSubscriptionObservation[]
  matchingTopics: ShopifyOrderSignalWebhookTopic[]
  missingTopics: ShopifyOrderSignalWebhookTopic[]
  conflictingTopics: ShopifyOrderSignalWebhookTopic[]
  ready: boolean
  processorState: 'available'
  providerWrites: 0
}>

export type ShopifyOrderWebhookMutationPlanItem = Readonly<{
  topic: ShopifyOrderSignalWebhookTopic
  action: 'create' | 'update'
  providerId: string | null
}>

export type ShopifyOrderWebhookMutationCompletion = Readonly<{
  topic: ShopifyOrderSignalWebhookTopic
  action: 'create' | 'update'
  providerId: string
}>

export type ShopifyOrderWebhookReconciliationResult = Readonly<{
  before: ShopifyOrderWebhookSubscriptionReadiness
  after: ShopifyOrderWebhookSubscriptionReadiness
  plan: readonly ShopifyOrderWebhookMutationPlanItem[]
  providerWrites: number
  providerReferences: readonly string[]
  completedMutations: readonly ShopifyOrderWebhookMutationCompletion[]
}>

export class ShopifyOrderWebhookError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ShopifyOrderWebhookError'
  }
}

export class ShopifyOrderWebhookDispatchError extends ShopifyOrderWebhookError {
  constructor(
    code: string,
    message: string,
    status: number,
    readonly stopClassification: 'deterministic_rejection' | 'ambiguous',
    readonly stoppedMutation: ShopifyOrderWebhookMutationPlanItem | null,
    readonly completedMutations: readonly ShopifyOrderWebhookMutationCompletion[],
  ) {
    super(code, message, status)
    this.name = 'ShopifyOrderWebhookDispatchError'
  }
}

export function isShopifyOrderSignalWebhookTopic(
  value: unknown,
): value is ShopifyOrderSignalWebhookTopic {
  return typeof value === 'string' && TOPIC_SET.has(value)
}

function jsonStringEnd(source: string, start: number) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
    } else if (source[index] === '"') {
      return index
    }
  }
  return -1
}

function exactTopLevelKeys(source: string) {
  const keys: string[] = []
  const seen = new Set<string>()
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      const end = jsonStringEnd(source, index)
      if (end < 0) {
        throw new ShopifyOrderWebhookError(
          'SHOPIFY_ORDER_WEBHOOK_PAYLOAD_INVALID',
          'Shopify order webhook payload is invalid',
        )
      }
      if (depth === 1) {
        let separator = end + 1
        while (/\s/u.test(source[separator] || '')) separator += 1
        if (source[separator] === ':') {
          let key: unknown
          try {
            key = JSON.parse(source.slice(index, end + 1))
          } catch {
            key = null
          }
          if (
            typeof key !== 'string'
            || seen.has(key)
            || !REQUIRED_PAYLOAD_KEY_SET.has(key)
          ) {
            throw new ShopifyOrderWebhookError(
              'SHOPIFY_ORDER_WEBHOOK_PAYLOAD_PROFILE_INVALID',
              'Shopify order webhook payload does not match the minimized field profile',
              422,
            )
          }
          seen.add(key)
          keys.push(key)
        }
      }
      index = end
      continue
    }
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
    if (depth < 0) {
      throw new ShopifyOrderWebhookError(
        'SHOPIFY_ORDER_WEBHOOK_PAYLOAD_INVALID',
        'Shopify order webhook payload is invalid',
      )
    }
  }
  return keys
}

function exactIso(value: unknown) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 20
    || value.length > 64
  ) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

/**
 * Derive a payload-free exact-order signal only after the caller verifies the
 * Shopify raw-body HMAC, current credential generation, and shop domain.
 * The accepted body must be the exact includeFields profile configured on the
 * provider subscription; customer and address fields are rejected.
 */
export function shopifyOrderWebhookSignalEvidence(input: {
  topic: unknown
  verifiedRawBody: Buffer
  now?: string | Date
}): ShopifyOrderWebhookSignalEvidence {
  if (!isShopifyOrderSignalWebhookTopic(input.topic)) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_TOPIC_UNSUPPORTED',
      'Shopify order webhook topic is not accepted',
      422,
    )
  }
  if (
    !Buffer.isBuffer(input.verifiedRawBody)
    || input.verifiedRawBody.byteLength < 2
    || input.verifiedRawBody.byteLength > SHOPIFY_ORDER_SIGNAL_MAX_BYTES
  ) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_TOO_LARGE',
      'Shopify order webhook payload is invalid or too large',
      413,
    )
  }
  const source = input.verifiedRawBody.toString('utf8')
  const keys = exactTopLevelKeys(source)
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_PAYLOAD_INVALID',
      'Shopify order webhook payload must be valid JSON',
    )
  }
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || keys.length !== SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS.length
    || SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS.some((key) => !keys.includes(key))
  ) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_PAYLOAD_PROFILE_INVALID',
      'Shopify order webhook payload does not match the minimized field profile',
      422,
    )
  }
  const record = payload as Record<string, unknown>
  const externalOrderId = record.admin_graphql_api_id
  const providerUpdatedAt = exactIso(record.updated_at)
  if (
    typeof externalOrderId !== 'string'
    || externalOrderId !== externalOrderId.trim()
    || !ORDER_GID_PATTERN.test(externalOrderId)
    || !providerUpdatedAt
  ) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_EVIDENCE_INVALID',
      'Shopify order webhook identity or updated timestamp is invalid',
      422,
    )
  }
  const now = new Date(input.now || new Date())
  if (
    !Number.isFinite(now.getTime())
    || new Date(providerUpdatedAt).getTime() > now.getTime() + 10 * 60 * 1_000
  ) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_TIMESTAMP_INVALID',
      'Shopify order webhook updated timestamp is invalid',
      422,
    )
  }
  return Object.freeze({
    topic: input.topic,
    externalOrderId,
    providerUpdatedAt,
    payloadHash: createHash('sha256')
      .update(input.verifiedRawBody)
      .digest('hex'),
    payloadBytes: input.verifiedRawBody.byteLength,
  })
}

const SHOPIFY_ORDER_WEBHOOK_SUBSCRIPTIONS_QUERY = `query ClawPilotOrderWebhookSubscriptions($topics: [WebhookSubscriptionTopic!]) {
  webhookSubscriptions(first: 100, topics: $topics) {
    nodes {
      id
      topic
      uri
      format
      includeFields
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

function exactHttpsUri(value: string) {
  try {
    const parsed = new URL(value)
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.hash
      || parsed.search
    ) throw new Error('invalid URI')
    return parsed.toString()
  } catch {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_URI_INVALID',
      'A public HTTPS Shopify order webhook URI is required',
    )
  }
}

function exactStringArray(value: unknown) {
  if (
    !Array.isArray(value)
    || value.length > 32
    || value.some((entry) =>
      typeof entry !== 'string'
      || entry !== entry.trim()
      || entry.length < 1
      || entry.length > 128)
  ) return null
  const unique = new Set(value as string[])
  if (unique.size !== value.length) return null
  return [...unique].sort()
}

function equalStringArrays(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

/**
 * Revalidate the persisted discovery evidence at the point a signed delivery
 * is accepted. Callers must pass the current, locked account configuration;
 * an earlier runtime snapshot is not sufficient because a later read-only
 * discovery may already have downgraded the subscription profile.
 */
function exactShopifyOrderWebhookSubscriptionEvidence(
  value: unknown,
  input: {
    accountGlobalId: string
    credentialGeneration: number
    desiredUri?: string
  },
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const evidence = value as Record<string, unknown>
  if (
    evidence.accountGlobalId !== input.accountGlobalId
    || evidence.credentialGeneration !== input.credentialGeneration
    || !Number.isSafeInteger(input.credentialGeneration)
    || input.credentialGeneration < 1
  ) return null

  let desiredUri: string
  try {
    if (typeof evidence.desiredUri !== 'string') return null
    desiredUri = exactHttpsUri(evidence.desiredUri)
    const parsed = new URL(desiredUri)
    if (
      desiredUri !== evidence.desiredUri
      || (input.desiredUri !== undefined
        && desiredUri !== exactHttpsUri(input.desiredUri))
      || parsed.pathname !==
        `/api/integrations/commerce/shopify/webhooks/${input.accountGlobalId}`
    ) return null
  } catch {
    return null
  }

  const requiredTopics = exactStringArray(evidence.requiredTopics)
  const requiredIncludeFields = exactStringArray(
    evidence.requiredIncludeFields,
  )
  const missingTopics = exactStringArray(evidence.missingTopics)
  const conflictingTopics = exactStringArray(evidence.conflictingTopics)
  const observedAt = exactIso(evidence.observedAt)
  if (!observedAt || observedAt !== evidence.observedAt) return null
  return Boolean(
    requiredTopics
    && equalStringArrays(
      requiredTopics,
      [...SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS].sort(),
    )
    && requiredIncludeFields
    && equalStringArrays(
      requiredIncludeFields,
      [...SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS].sort(),
    )
    && missingTopics?.length === 0
    && conflictingTopics?.length === 0
    && evidence.observedCount === SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS.length
    && evidence.matchingCount === SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS.length
    && evidence.subscriptionReady === true
    && evidence.processorState === 'available'
    && evidence.exactReadProcessorReady === true
    && evidence.scheduledPollBackstop === true
    && evidence.ready === true
    && evidence.discoveryState === 'succeeded'
    && evidence.discoveryErrorCode === null
    && evidence.providerWrites === 0
  ) ? { evidence, observedAt } : null
}

/**
 * Signed inbound delivery fence. Exact account generation, callback URI,
 * seven-topic/two-field profile, and processor evidence remain mandatory, but
 * the age of a previously successful discovery does not reject live traffic.
 */
export function shopifyOrderWebhookSubscriptionEvidenceAcceptsDelivery(
  value: unknown,
  input: {
    accountGlobalId: string
    credentialGeneration: number
    desiredUri: string
  },
) {
  return exactShopifyOrderWebhookSubscriptionEvidence(value, input) !== null
}

/** Operational/UI readiness keeps the 24-hour discovery freshness signal. */
export function shopifyOrderWebhookSubscriptionEvidenceReady(
  value: unknown,
  input: {
    accountGlobalId: string
    credentialGeneration: number
    desiredUri?: string
    now?: string | Date
  },
) {
  const exact = exactShopifyOrderWebhookSubscriptionEvidence(value, input)
  const now = new Date(input.now || new Date())
  return Boolean(
    exact
    && Number.isFinite(now.getTime())
    && new Date(exact.observedAt).getTime() >= now.getTime()
      - SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS * 1_000
    && new Date(exact.observedAt).getTime() <= now.getTime() + 10 * 60 * 1_000
  )
}

/** Read-only provider discovery. This function has no registration mutation. */
export async function discoverShopifyOrderWebhookSubscriptions(
  credential: ShopifyCommerceRuntimeCredential,
  input: { desiredUri: string },
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyOrderWebhookSubscriptionReadiness> {
  const desiredUri = exactHttpsUri(input.desiredUri)
  const requiredTopics = [...SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS]
  const requiredIncludeFields = [...SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS].sort()
  const data = await shopifyAdminGraphql<{
    webhookSubscriptions?: { nodes?: unknown[]; pageInfo?: unknown }
  }>(credential, {
    query: SHOPIFY_ORDER_WEBHOOK_SUBSCRIPTIONS_QUERY,
    operationName: 'ClawPilotOrderWebhookSubscriptions',
    variables: {
      topics: requiredTopics.map((topic) => SHOPIFY_ORDER_TOPIC_ENUMS[topic]),
    },
  }, options)
  const connection = data.webhookSubscriptions
  const pageInfo = connection?.pageInfo
  if (
    !connection
    || !Array.isArray(connection.nodes)
    || !pageInfo
    || typeof pageInfo !== 'object'
    || Array.isArray(pageInfo)
    || typeof (pageInfo as Record<string, unknown>).hasNextPage !== 'boolean'
    || (
      (pageInfo as Record<string, unknown>).endCursor !== null
      && typeof (pageInfo as Record<string, unknown>).endCursor !== 'string'
    )
  ) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_INVALID',
      'Shopify order webhook subscription discovery was incomplete',
      502,
    )
  }
  const hasNextPage = (pageInfo as Record<string, unknown>).hasNextPage
  const endCursor = (pageInfo as Record<string, unknown>).endCursor
  if (
    endCursor !== null
    && (
      typeof endCursor !== 'string'
      || endCursor.length < 1
      || endCursor.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(endCursor)
    )
  ) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_INVALID',
      'Shopify order webhook subscription discovery was incomplete',
      502,
    )
  }
  if (
    hasNextPage
    && typeof endCursor !== 'string'
  ) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_INVALID',
      'Shopify order webhook subscription discovery was incomplete',
      502,
    )
  }
  if (hasNextPage) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_TRUNCATED',
      'Shopify order webhook subscription discovery exceeded the bounded profile',
      409,
    )
  }
  const subscriptions: ShopifyOrderWebhookSubscriptionObservation[] = []
  for (const value of connection.nodes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ShopifyOrderWebhookError(
        'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_INVALID',
        'Shopify returned malformed order webhook subscription evidence',
        502,
      )
    }
    const node = value as Record<string, unknown>
    const topic = Object.entries(SHOPIFY_ORDER_TOPIC_ENUMS)
      .find(([, providerTopic]) => providerTopic === node.topic)?.[0]
    const includeFields = exactStringArray(node.includeFields)
    const format = node.format === 'JSON' || node.format === 'XML'
      ? node.format
      : null
    if (
      !topic
      || !isShopifyOrderSignalWebhookTopic(topic)
      || typeof node.id !== 'string'
      || !/^gid:\/\/shopify\/WebhookSubscription\/[1-9][0-9]*$/u.test(node.id)
      || typeof node.uri !== 'string'
      || node.uri.length > 2_048
      || !format
      || !includeFields
    ) {
      throw new ShopifyOrderWebhookError(
        'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_INVALID',
        'Shopify returned malformed order webhook subscription evidence',
        502,
      )
    }
    const exactProfile = node.uri === desiredUri
      && format === 'JSON'
      && equalStringArrays(includeFields, requiredIncludeFields)
    subscriptions.push(Object.freeze({
      providerId: node.id,
      topic,
      uri: node.uri,
      format,
      includeFields,
      exactProfile,
    }))
  }
  subscriptions.sort((left, right) =>
    left.topic.localeCompare(right.topic)
    || left.providerId.localeCompare(right.providerId))
  const matchingTopics = requiredTopics.filter((topic) =>
    subscriptions.some((subscription) =>
      subscription.topic === topic && subscription.exactProfile))
  const missingTopics = requiredTopics.filter((topic) =>
    !matchingTopics.includes(topic))
  const conflictingTopics = requiredTopics.filter((topic) =>
    subscriptions.filter((subscription) => subscription.topic === topic)
      .length !== 1
    || subscriptions.some((subscription) =>
      subscription.topic === topic && !subscription.exactProfile))
  return Object.freeze({
    desiredUri,
    requiredTopics,
    requiredIncludeFields,
    subscriptions,
    matchingTopics,
    missingTopics,
    conflictingTopics,
    ready: missingTopics.length === 0 && conflictingTopics.length === 0,
    processorState: 'available',
    providerWrites: 0,
  })
}

const SHOPIFY_ORDER_WEBHOOK_SUBSCRIPTION_CREATE_MUTATION =
  `mutation ClawPilotOrderWebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $subscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: $subscription
    ) {
      webhookSubscription { id topic uri format includeFields }
      userErrors { field message }
    }
  }`

const SHOPIFY_ORDER_WEBHOOK_SUBSCRIPTION_UPDATE_MUTATION =
  `mutation ClawPilotOrderWebhookSubscriptionUpdate(
    $id: ID!
    $subscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionUpdate(
      id: $id
      webhookSubscription: $subscription
    ) {
      webhookSubscription { id topic uri format includeFields }
      userErrors { field message }
    }
  }`

function mutationPlan(
  readiness: ShopifyOrderWebhookSubscriptionReadiness,
): ShopifyOrderWebhookMutationPlanItem[] {
  const plan: ShopifyOrderWebhookMutationPlanItem[] = []
  for (const topic of SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS) {
    const current = readiness.subscriptions.filter(
      (subscription) => subscription.topic === topic,
    )
    if (current.length > 1) {
      throw new ShopifyOrderWebhookError(
        'SHOPIFY_ORDER_WEBHOOK_DUPLICATE_REVIEW_REQUIRED',
        `Shopify has multiple ${topic} subscriptions; review them before reconciliation`,
        409,
      )
    }
    if (current.length === 0) {
      plan.push(Object.freeze({ topic, action: 'create', providerId: null }))
    } else if (!current[0].exactProfile) {
      plan.push(Object.freeze({
        topic,
        action: 'update',
        providerId: current[0].providerId,
      }))
    }
  }
  return plan
}

export function planShopifyOrderWebhookReconciliation(
  readiness: ShopifyOrderWebhookSubscriptionReadiness,
) {
  return Object.freeze(mutationPlan(readiness))
}

export function decideShopifyOrderWebhookRecovery(
  commandStatus: 'prepared' | 'recoverable' | 'unknown',
  readiness: ShopifyOrderWebhookSubscriptionReadiness,
) {
  if (readiness.ready) {
    return Object.freeze({
      action: 'reconcile_read_only' as const,
      plan: Object.freeze([] as ShopifyOrderWebhookMutationPlanItem[]),
    })
  }
  if (commandStatus === 'unknown') {
    return Object.freeze({
      action: 'manual_review' as const,
      plan: Object.freeze([] as ShopifyOrderWebhookMutationPlanItem[]),
    })
  }
  return Object.freeze({
    action: 'dispatch' as const,
    plan: Object.freeze(mutationPlan(readiness)),
  })
}

function exactMutationNode(
  value: unknown,
  expected: {
    topic: ShopifyOrderSignalWebhookTopic
    desiredUri: string
    providerId: string | null
  },
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_MUTATION_RESPONSE_INVALID',
      'Shopify returned invalid order webhook mutation evidence',
      502,
    )
  }
  const node = value as Record<string, unknown>
  const includeFields = exactStringArray(node.includeFields)
  if (
    typeof node.id !== 'string'
    || !/^gid:\/\/shopify\/WebhookSubscription\/[1-9][0-9]*$/u.test(node.id)
    || (expected.providerId !== null && node.id !== expected.providerId)
    || node.topic !== SHOPIFY_ORDER_TOPIC_ENUMS[expected.topic]
    || node.uri !== expected.desiredUri
    || node.format !== 'JSON'
    || !includeFields
    || !equalStringArrays(
      includeFields,
      [...SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS].sort(),
    )
  ) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_MUTATION_RESPONSE_INVALID',
      'Shopify returned invalid order webhook mutation evidence',
      502,
    )
  }
  return node.id
}

async function applyShopifyOrderWebhookMutation(
  credential: ShopifyCommerceRuntimeCredential,
  desiredUri: string,
  plan: ShopifyOrderWebhookMutationPlanItem,
  options: ShopifyCommerceClientOptions,
) {
  const request = {
    uri: desiredUri,
    format: 'JSON',
    includeFields: [...SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS],
  }
  const update = plan.action === 'update'
  const data = await shopifyAdminGraphql<Record<string, unknown>>(
    credential,
    {
      query: update
        ? SHOPIFY_ORDER_WEBHOOK_SUBSCRIPTION_UPDATE_MUTATION
        : SHOPIFY_ORDER_WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
      operationName: update
        ? 'ClawPilotOrderWebhookSubscriptionUpdate'
        : 'ClawPilotOrderWebhookSubscriptionCreate',
      variables: update
        ? { id: plan.providerId, subscription: request }
        : {
            topic: SHOPIFY_ORDER_TOPIC_ENUMS[plan.topic],
            subscription: request,
          },
    },
    options,
  )
  const result = data[update
    ? 'webhookSubscriptionUpdate'
    : 'webhookSubscriptionCreate']
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_MUTATION_RESPONSE_INVALID',
      'Shopify returned invalid order webhook mutation evidence',
      502,
    )
  }
  const payload = result as Record<string, unknown>
  if (!Array.isArray(payload.userErrors)) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_MUTATION_RESPONSE_INVALID',
      'Shopify returned invalid order webhook mutation evidence',
      502,
    )
  }
  if (payload.userErrors.length > 0) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_MUTATION_REJECTED',
      'Shopify rejected the minimized order webhook profile',
      422,
    )
  }
  return exactMutationNode(payload.webhookSubscription, {
    topic: plan.topic,
    desiredUri,
    providerId: plan.providerId,
  })
}

/**
 * Reconcile only the bounded order-signal subscriptions. Existing unrelated
 * topics are never queried or deleted. A duplicated required topic fails
 * closed so an operator can review it without ClawPilot removing evidence.
 */
export async function reconcileShopifyOrderWebhookSubscriptions(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    desiredUri: string
    expectedPlan?: readonly ShopifyOrderWebhookMutationPlanItem[]
    preparedReadiness?: ShopifyOrderWebhookSubscriptionReadiness
  },
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyOrderWebhookReconciliationResult> {
  const desiredUri = exactHttpsUri(input.desiredUri)
  const before = input.preparedReadiness
    || await discoverShopifyOrderWebhookSubscriptions(
      credential,
      { desiredUri },
      options,
    )
  if (before.desiredUri !== desiredUri) {
    throw new ShopifyOrderWebhookError(
      'SHOPIFY_ORDER_WEBHOOK_PLAN_DRIFT',
      'Shopify order webhook callback changed before reconciliation',
      409,
    )
  }
  const plan = mutationPlan(before)
  if (input.expectedPlan) {
    const expected = JSON.stringify(input.expectedPlan)
    if (JSON.stringify(plan) !== expected) {
      throw new ShopifyOrderWebhookError(
        'SHOPIFY_ORDER_WEBHOOK_PLAN_DRIFT',
        'Shopify order webhook subscriptions changed before reconciliation',
        409,
      )
    }
  }
  const completedMutations: ShopifyOrderWebhookMutationCompletion[] = []
  for (const item of plan) {
    try {
      const providerId = await applyShopifyOrderWebhookMutation(
        credential,
        before.desiredUri,
        item,
        options,
      )
      completedMutations.push(Object.freeze({
        topic: item.topic,
        action: item.action,
        providerId,
      }))
    } catch (error) {
      const known = error instanceof ShopifyOrderWebhookError
        ? error
        : null
      throw new ShopifyOrderWebhookDispatchError(
        known?.code || 'SHOPIFY_ORDER_WEBHOOK_MUTATION_OUTCOME_UNKNOWN',
        known?.message || 'Shopify order webhook mutation outcome is uncertain',
        known?.status || 502,
        known?.code === 'SHOPIFY_ORDER_WEBHOOK_MUTATION_REJECTED'
          ? 'deterministic_rejection'
          : 'ambiguous',
        item,
        Object.freeze([...completedMutations]),
      )
    }
  }
  let after: ShopifyOrderWebhookSubscriptionReadiness
  try {
    after = await discoverShopifyOrderWebhookSubscriptions(
      credential,
      { desiredUri: before.desiredUri },
      options,
    )
  } catch (error) {
    if (plan.length === 0) throw error
    const known = error instanceof ShopifyOrderWebhookError ? error : null
    throw new ShopifyOrderWebhookDispatchError(
      known?.code || 'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_UNVERIFIED',
      known?.message || 'Shopify order webhook verification is uncertain',
      known?.status || 502,
      'ambiguous',
      null,
      Object.freeze([...completedMutations]),
    )
  }
  if (!after.ready) {
    throw new ShopifyOrderWebhookDispatchError(
      'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_UNVERIFIED',
      'Shopify order webhook reconciliation could not be verified',
      502,
      'ambiguous',
      null,
      Object.freeze([...completedMutations]),
    )
  }
  const providerReferences = completedMutations.map(
    (completion) => completion.providerId,
  )
  return Object.freeze({
    before,
    after,
    plan,
    providerWrites: plan.length,
    providerReferences: Object.freeze(providerReferences),
    completedMutations: Object.freeze([...completedMutations]),
  })
}
