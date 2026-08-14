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
export function shopifyOrderWebhookSubscriptionEvidenceReady(
  value: unknown,
  input: {
    accountGlobalId: string
    credentialGeneration: number
    now?: string | Date
  },
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const evidence = value as Record<string, unknown>
  if (
    evidence.accountGlobalId !== input.accountGlobalId
    || evidence.credentialGeneration !== input.credentialGeneration
    || !Number.isSafeInteger(input.credentialGeneration)
    || input.credentialGeneration < 1
  ) return false

  let desiredUri: string
  try {
    if (typeof evidence.desiredUri !== 'string') return false
    desiredUri = exactHttpsUri(evidence.desiredUri)
    const parsed = new URL(desiredUri)
    if (
      desiredUri !== evidence.desiredUri
      || parsed.pathname !==
        `/api/integrations/commerce/shopify/webhooks/${input.accountGlobalId}`
    ) return false
  } catch {
    return false
  }

  const requiredTopics = exactStringArray(evidence.requiredTopics)
  const requiredIncludeFields = exactStringArray(
    evidence.requiredIncludeFields,
  )
  const missingTopics = exactStringArray(evidence.missingTopics)
  const conflictingTopics = exactStringArray(evidence.conflictingTopics)
  const observedAt = exactIso(evidence.observedAt)
  const now = new Date(input.now || new Date())
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
    && observedAt
    && observedAt === evidence.observedAt
    && Number.isFinite(now.getTime())
    && new Date(observedAt).getTime() >= now.getTime()
      - SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS * 1_000
    && new Date(observedAt).getTime() <= now.getTime() + 10 * 60 * 1_000
    && evidence.discoveryState === 'succeeded'
    && evidence.discoveryErrorCode === null
    && evidence.providerWrites === 0
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
