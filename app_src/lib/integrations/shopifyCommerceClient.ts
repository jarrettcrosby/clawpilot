import crypto from 'crypto'
import { SHOPIFY_ADMIN_API_VERSION } from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyStoreEntityName,
} from '@/lib/integrations/shopifyCarrierServiceBranding'

const MAX_QUERY_BYTES = 64 * 1024
const MAX_VARIABLE_BYTES = 256 * 1024
const MAX_REQUEST_BYTES = 320 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 12_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 20_000
const SHOPIFY_SHOP_GID_PATTERN = /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/
const SHOPIFY_SCOPE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/
const GRAPHQL_OPERATION_PATTERN = /^[_A-Za-z][_0-9A-Za-z]{0,79}$/
const MYSHOPIFY_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/

export type ShopifyCommerceRuntimeCredential = {
  shopDomain: string
  accessToken: string
}

export type ShopifyClientCredentials = {
  shopDomain: string
  clientId: string
  clientSecret: string
}

export type ShopifyAccessTokenGrant = {
  accessToken: string
  grantedScopes: string[]
  expiresIn: number
  expiresAt: string
}

export type ShopifyGraphqlRequest = {
  query: string
  variables?: Record<string, unknown>
  operationName?: string
}

export type ShopifyCommerceClientOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type ShopifyConnectionProbe = {
  provider: 'shopify'
  apiVersion: typeof SHOPIFY_ADMIN_API_VERSION
  shopId: string
  shopDomain: string
  shopName: string
  grantedScopes: string[]
}

export type ShopifyWebhookSubscriptionObservation = {
  providerId: string
  topic: string
  uri: string
}

export type ShopifyWebhookSubscriptionReadiness = {
  desiredUri: string
  requiredTopics: string[]
  subscriptions: ShopifyWebhookSubscriptionObservation[]
  missingTopics: string[]
  conflictingTopics: string[]
  ready: boolean
}

export type ShopifyWebhookSubscriptionCreateResult = {
  providerId: string
  topic: string
  uri: string
}

export class ShopifyCommerceClientError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'SHOPIFY_UPSTREAM_FAILED',
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ShopifyCommerceClientError'
  }
}

function invalidInput(message: string, code: string) {
  return new ShopifyCommerceClientError(message, 400, code)
}

export function normalizeShopifyShopDomain(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidInput('A canonical Shopify store domain is required', 'SHOPIFY_DOMAIN_INVALID')
  }
  const domain = value.trim().toLowerCase()
  if (
    domain.length > 255
    || !MYSHOPIFY_DOMAIN_PATTERN.test(domain)
  ) {
    throw invalidInput(
      'Shopify store domain must be the canonical store-name.myshopify.com domain',
      'SHOPIFY_DOMAIN_INVALID',
    )
  }
  return domain
}

export const normalizeShopifyDomain = normalizeShopifyShopDomain

function normalizeAccessToken(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 8
    || value.length > 4_096
    || value !== value.trim()
    || !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw invalidInput('A valid Shopify access token is required', 'SHOPIFY_ACCESS_TOKEN_INVALID')
  }
  return value
}

function normalizeClientId(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 8
    || value.length > 255
    || value !== value.trim()
    || !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw invalidInput(
      'A valid Shopify app client ID is required',
      'SHOPIFY_CLIENT_ID_INVALID',
    )
  }
  return value
}

function normalizeClientSecret(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 16
    || value.length > 4_096
    || value !== value.trim()
    || !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw invalidInput(
      'A valid Shopify app client secret is required',
      'SHOPIFY_CLIENT_SECRET_INVALID',
    )
  }
  return value
}

export function shopifyAccessTokenEndpoint(shopDomain: unknown): string {
  return `https://${normalizeShopifyShopDomain(shopDomain)}/admin/oauth/access_token`
}

export function shopifyAdminGraphqlEndpoint(shopDomain: unknown): string {
  return `https://${normalizeShopifyShopDomain(shopDomain)}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`
}

function boundedTimeout(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.max(MIN_TIMEOUT_MS, Math.min(Math.floor(parsed), MAX_TIMEOUT_MS))
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function requestPayload(input: ShopifyGraphqlRequest): string {
  if (typeof input.query !== 'string') {
    throw invalidInput('Shopify GraphQL query is required', 'SHOPIFY_QUERY_INVALID')
  }
  const query = input.query.trim()
  if (
    !query
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)
    || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES
  ) {
    throw invalidInput('Shopify GraphQL query is invalid or too large', 'SHOPIFY_QUERY_INVALID')
  }
  if (
    input.operationName !== undefined
    && (
      typeof input.operationName !== 'string'
      || !GRAPHQL_OPERATION_PATTERN.test(input.operationName)
    )
  ) {
    throw invalidInput('Shopify GraphQL operation name is invalid', 'SHOPIFY_OPERATION_INVALID')
  }

  let variables: string
  try {
    const serialized = JSON.stringify(input.variables || {})
    if (typeof serialized !== 'string') throw new Error('invalid variables')
    variables = serialized
  } catch {
    throw invalidInput('Shopify GraphQL variables are invalid', 'SHOPIFY_VARIABLES_INVALID')
  }
  if (Buffer.byteLength(variables, 'utf8') > MAX_VARIABLE_BYTES) {
    throw invalidInput('Shopify GraphQL variables exceeded the safe size limit', 'SHOPIFY_VARIABLES_TOO_LARGE')
  }

  const payload = JSON.stringify({
    query,
    variables: JSON.parse(variables) as Record<string, unknown>,
    ...(input.operationName ? { operationName: input.operationName } : {}),
  })
  if (Buffer.byteLength(payload, 'utf8') > MAX_REQUEST_BYTES) {
    throw invalidInput('Shopify GraphQL request exceeded the safe size limit', 'SHOPIFY_REQUEST_TOO_LARGE')
  }
  return payload
}

async function readBoundedResponse(
  response: Response,
  maximum = MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new ShopifyCommerceClientError(
      'Shopify response exceeded the safe size limit',
      502,
      'SHOPIFY_RESPONSE_TOO_LARGE',
    )
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximum) {
      await reader.cancel().catch(() => undefined)
      throw new ShopifyCommerceClientError(
        'Shopify response exceeded the safe size limit',
        502,
        'SHOPIFY_RESPONSE_TOO_LARGE',
      )
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function responsePayload(bytes: Uint8Array): Record<string, unknown> | null {
  if (!bytes.byteLength) return null
  try {
    return safeRecord(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return null
  }
}

function graphqlErrorCode(payload: Record<string, unknown> | null): string {
  if (!payload || !Array.isArray(payload.errors)) return ''
  for (const error of payload.errors) {
    const extensions = safeRecord(safeRecord(error)?.extensions)
    const code = extensions?.code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code
  }
  return ''
}

function upstreamError(status: number, payload: Record<string, unknown> | null) {
  const graphqlCode = graphqlErrorCode(payload)
  if (status === 429 || graphqlCode === 'THROTTLED') {
    return new ShopifyCommerceClientError(
      'Shopify temporarily rate limited the integration',
      503,
      'SHOPIFY_RATE_LIMITED',
      true,
    )
  }
  if (status === 401 || status === 403 || graphqlCode === 'ACCESS_DENIED') {
    return new ShopifyCommerceClientError(
      'Shopify rejected the configured credential or required access scope',
      409,
      'SHOPIFY_ACCESS_DENIED',
    )
  }
  if (status === 404) {
    return new ShopifyCommerceClientError(
      'The configured Shopify store was not found',
      409,
      'SHOPIFY_STORE_NOT_FOUND',
    )
  }
  if (status >= 500) {
    return new ShopifyCommerceClientError(
      'Shopify is temporarily unavailable',
      503,
      'SHOPIFY_UNAVAILABLE',
      true,
    )
  }
  return new ShopifyCommerceClientError(
    'Shopify rejected the integration request',
    422,
    'SHOPIFY_REQUEST_REJECTED',
  )
}

export function sanitizedShopifyCommerceError(error: unknown): ShopifyCommerceClientError {
  if (error instanceof ShopifyCommerceClientError) return error
  return new ShopifyCommerceClientError(
    'Shopify integration request failed',
    502,
    'SHOPIFY_UPSTREAM_FAILED',
  )
}

function tokenGrantedScopes(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 16_384) {
    throw new ShopifyCommerceClientError(
      'Shopify returned an invalid access-token response',
      502,
      'SHOPIFY_TOKEN_RESPONSE_INVALID',
    )
  }
  const scopes = new Set<string>()
  for (const scope of value.split(/[,\s]+/).filter(Boolean)) {
    if (!SHOPIFY_SCOPE_PATTERN.test(scope)) {
      throw new ShopifyCommerceClientError(
        'Shopify returned an invalid access-token response',
        502,
        'SHOPIFY_TOKEN_RESPONSE_INVALID',
      )
    }
    scopes.add(scope)
  }
  return [...scopes].sort()
}

function tokenErrorIdentifier(payload: Record<string, unknown> | null) {
  return [payload?.error, payload?.error_description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
}

function tokenUpstreamError(
  status: number,
  payload: Record<string, unknown> | null,
) {
  if (status === 429) {
    return new ShopifyCommerceClientError(
      'Shopify temporarily rate limited token acquisition',
      503,
      'SHOPIFY_RATE_LIMITED',
      true,
    )
  }
  if (status >= 500) {
    return new ShopifyCommerceClientError(
      'Shopify token acquisition is temporarily unavailable',
      503,
      'SHOPIFY_UNAVAILABLE',
      true,
    )
  }
  if (status === 404) {
    return new ShopifyCommerceClientError(
      'The configured Shopify store was not found',
      409,
      'SHOPIFY_STORE_NOT_FOUND',
    )
  }
  const identifier = tokenErrorIdentifier(payload)
  if (identifier.includes('shop_not_permitted')) {
    return new ShopifyCommerceClientError(
      'Shopify requires the app and store to belong to the same Dev Dashboard organization',
      409,
      'SHOPIFY_SHOP_NOT_PERMITTED',
    )
  }
  if (
    identifier.includes('app_not_installed')
    || identifier.includes('app is not installed')
  ) {
    return new ShopifyCommerceClientError(
      'Install the released Shopify app on this store before connecting it',
      409,
      'SHOPIFY_APP_NOT_INSTALLED',
    )
  }
  return new ShopifyCommerceClientError(
    'Shopify rejected the app client credentials for this store',
    409,
    'SHOPIFY_CLIENT_CREDENTIALS_REJECTED',
  )
}

export async function requestShopifyAccessToken(
  credential: ShopifyClientCredentials,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyAccessTokenGrant> {
  const shopDomain = normalizeShopifyShopDomain(credential.shopDomain)
  const clientId = normalizeClientId(credential.clientId)
  const clientSecret = normalizeClientSecret(credential.clientSecret)
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  })
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    boundedTimeout(options.timeoutMs),
  )
  try {
    const response = await (options.fetchImpl || fetch)(
      shopifyAccessTokenEndpoint(shopDomain),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      },
    )
    const bytes = await readBoundedResponse(
      response,
      MAX_TOKEN_RESPONSE_BYTES,
    )
    const payload = responsePayload(bytes)
    if (!response.ok) throw tokenUpstreamError(response.status, payload)
    const expiresIn = Number(payload?.expires_in)
    if (
      !payload
      || !Number.isInteger(expiresIn)
      || expiresIn < 60
      || expiresIn > 86_400
    ) {
      throw new ShopifyCommerceClientError(
        'Shopify returned an invalid access-token response',
        502,
        'SHOPIFY_TOKEN_RESPONSE_INVALID',
      )
    }
    let accessToken: string
    try {
      accessToken = normalizeAccessToken(payload.access_token)
    } catch {
      throw new ShopifyCommerceClientError(
        'Shopify returned an invalid access-token response',
        502,
        'SHOPIFY_TOKEN_RESPONSE_INVALID',
      )
    }
    return {
      accessToken,
      grantedScopes: tokenGrantedScopes(payload.scope),
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    }
  } catch (error) {
    if (error instanceof ShopifyCommerceClientError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ShopifyCommerceClientError(
        'Shopify token acquisition timed out',
        504,
        'SHOPIFY_TIMEOUT',
        true,
      )
    }
    throw sanitizedShopifyCommerceError(error)
  } finally {
    clearTimeout(timeout)
  }
}

export async function shopifyAdminGraphql<T>(
  credential: ShopifyCommerceRuntimeCredential,
  input: ShopifyGraphqlRequest,
  options: ShopifyCommerceClientOptions = {},
): Promise<T> {
  const shopDomain = normalizeShopifyShopDomain(credential.shopDomain)
  const accessToken = normalizeAccessToken(credential.accessToken)
  const body = requestPayload(input)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), boundedTimeout(options.timeoutMs))
  try {
    const response = await (options.fetchImpl || fetch)(shopifyAdminGraphqlEndpoint(shopDomain), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    const bytes = await readBoundedResponse(response)
    const payload = responsePayload(bytes)
    if (!response.ok || (payload && Array.isArray(payload.errors) && payload.errors.length)) {
      throw upstreamError(response.status, payload)
    }
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data') || payload.data === null) {
      throw new ShopifyCommerceClientError(
        'Shopify returned an invalid GraphQL response',
        502,
        'SHOPIFY_RESPONSE_INVALID',
      )
    }
    return payload.data as T
  } catch (error) {
    if (error instanceof ShopifyCommerceClientError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ShopifyCommerceClientError(
        'Shopify request timed out',
        504,
        'SHOPIFY_TIMEOUT',
        true,
      )
    }
    throw sanitizedShopifyCommerceError(error)
  } finally {
    clearTimeout(timeout)
  }
}

export const shopifyGraphqlRequest = shopifyAdminGraphql

const SHOPIFY_WEBHOOK_SUBSCRIPTIONS_QUERY = `query ClawPilotWebhookSubscriptions($topics: [WebhookSubscriptionTopic!]) {
  webhookSubscriptions(first: 100, topics: $topics) {
    nodes {
      id
      topic
      uri
    }
  }
}`

const SHOPIFY_WEBHOOK_TOPIC_ENUMS = {
  'app/scopes_update': 'APP_SCOPES_UPDATE',
  'inventory_items/update': 'INVENTORY_ITEMS_UPDATE',
  'inventory_levels/update': 'INVENTORY_LEVELS_UPDATE',
  'products/create': 'PRODUCTS_CREATE',
  'products/delete': 'PRODUCTS_DELETE',
  'products/update': 'PRODUCTS_UPDATE',
} as const

const SHOPIFY_WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `mutation ClawPilotWebhookSubscriptionCreate(
  $topic: WebhookSubscriptionTopic!
  $subscription: WebhookSubscriptionInput!
) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`

function shopifyWebhookTopicEnum(topic: string) {
  const providerTopic = SHOPIFY_WEBHOOK_TOPIC_ENUMS[
    topic as keyof typeof SHOPIFY_WEBHOOK_TOPIC_ENUMS
  ]
  if (!providerTopic) {
    throw invalidInput('Shopify webhook topic is not supported', 'SHOPIFY_WEBHOOK_TOPIC_INVALID')
  }
  return providerTopic
}

export async function createShopifyWebhookSubscription(
  credential: ShopifyCommerceRuntimeCredential,
  input: { uri: string; topic: string },
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyWebhookSubscriptionCreateResult> {
  const readiness = await discoverShopifyWebhookSubscriptions(
    credential,
    { desiredUri: input.uri, topics: [input.topic] },
    options,
  )
  const existing = readiness.subscriptions.find((subscription) =>
    subscription.topic === input.topic && subscription.uri === readiness.desiredUri)
  if (existing) return existing
  const data = await shopifyAdminGraphql<{
    webhookSubscriptionCreate?: {
      webhookSubscription?: unknown
      userErrors?: unknown[]
    }
  }>(credential, {
    query: SHOPIFY_WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
    operationName: 'ClawPilotWebhookSubscriptionCreate',
    variables: {
      topic: shopifyWebhookTopicEnum(input.topic),
      subscription: { uri: readiness.desiredUri, format: 'JSON' },
    },
  }, options)
  const result = data.webhookSubscriptionCreate
  if (Array.isArray(result?.userErrors) && result.userErrors.length) {
    throw new ShopifyCommerceClientError(
      'Shopify rejected the webhook subscription configuration',
      422,
      'SHOPIFY_WEBHOOK_SUBSCRIPTION_REJECTED',
    )
  }
  const node = safeRecord(result?.webhookSubscription)
  if (
    !node
    || typeof node.id !== 'string'
    || typeof node.topic !== 'string'
    || typeof node.uri !== 'string'
    || !/^gid:\/\/shopify\/WebhookSubscription\/[1-9][0-9]*$/.test(node.id)
  ) {
    throw new ShopifyCommerceClientError(
      'Shopify returned invalid webhook subscription evidence',
      502,
      'SHOPIFY_WEBHOOK_SUBSCRIPTION_RESPONSE_INVALID',
    )
  }
  return { providerId: node.id, topic: input.topic, uri: node.uri }
}

export async function discoverShopifyWebhookSubscriptions(
  credential: ShopifyCommerceRuntimeCredential,
  input: { desiredUri: string; topics: readonly string[] },
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyWebhookSubscriptionReadiness> {
  let desiredUri: string
  try {
    const parsed = new URL(input.desiredUri)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new Error('invalid URI')
    }
    desiredUri = parsed.toString()
  } catch {
    throw invalidInput('A public HTTPS Shopify webhook URI is required', 'SHOPIFY_WEBHOOK_URI_INVALID')
  }
  const requiredTopics = [...new Set(input.topics)].sort()
  const providerTopics = requiredTopics.map(shopifyWebhookTopicEnum)
  const data = await shopifyAdminGraphql<{
    webhookSubscriptions?: { nodes?: unknown[] }
  }>(credential, {
    query: SHOPIFY_WEBHOOK_SUBSCRIPTIONS_QUERY,
    operationName: 'ClawPilotWebhookSubscriptions',
    variables: { topics: providerTopics },
  }, options)
  const observations: ShopifyWebhookSubscriptionObservation[] = []
  for (const value of data.webhookSubscriptions?.nodes || []) {
    const node = safeRecord(value)
    if (
      !node
      || typeof node.id !== 'string'
      || typeof node.topic !== 'string'
      || typeof node.uri !== 'string'
      || !/^gid:\/\/shopify\/WebhookSubscription\/[1-9][0-9]*$/.test(node.id)
    ) continue
    const topic = Object.entries(SHOPIFY_WEBHOOK_TOPIC_ENUMS)
      .find(([, providerTopic]) => providerTopic === node.topic)?.[0]
    if (!topic || !requiredTopics.includes(topic)) continue
    observations.push({ providerId: node.id, topic, uri: node.uri })
  }
  observations.sort((left, right) => left.topic.localeCompare(right.topic)
    || left.providerId.localeCompare(right.providerId))
  const missingTopics = requiredTopics.filter((topic) =>
    !observations.some((observation) =>
      observation.topic === topic && observation.uri === desiredUri))
  const conflictingTopics = requiredTopics.filter((topic) =>
    observations.some((observation) =>
      observation.topic === topic && observation.uri !== desiredUri))
  return {
    desiredUri,
    requiredTopics,
    subscriptions: observations,
    missingTopics,
    conflictingTopics,
    ready: missingTopics.length === 0 && conflictingTopics.length === 0,
  }
}

const SHOPIFY_CONNECTION_PROBE_QUERY = `query ClawPilotShopifyConnectionProbe {
  shop {
    id
    myshopifyDomain
    name
  }
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}`

function probeShopName(value: unknown): string {
  try {
    return normalizeShopifyStoreEntityName(value)
  } catch {
    throw new ShopifyCommerceClientError(
      'Shopify returned invalid store identity data',
      502,
      'SHOPIFY_PROBE_INVALID',
    )
  }
}

function probeGrantedScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new ShopifyCommerceClientError(
      'Shopify returned invalid access-scope data',
      502,
      'SHOPIFY_PROBE_INVALID',
    )
  }
  const scopes = new Set<string>()
  for (const entry of value) {
    const handle = safeRecord(entry)?.handle
    if (typeof handle !== 'string' || !SHOPIFY_SCOPE_PATTERN.test(handle)) {
      throw new ShopifyCommerceClientError(
        'Shopify returned invalid access-scope data',
        502,
        'SHOPIFY_PROBE_INVALID',
      )
    }
    scopes.add(handle)
  }
  return [...scopes].sort()
}

export async function probeShopifyConnection(
  credential: ShopifyCommerceRuntimeCredential,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyConnectionProbe> {
  const requestedDomain = normalizeShopifyShopDomain(credential.shopDomain)
  const data = await shopifyAdminGraphql<{
    shop?: unknown
    currentAppInstallation?: unknown
  }>(
    credential,
    {
      query: SHOPIFY_CONNECTION_PROBE_QUERY,
      operationName: 'ClawPilotShopifyConnectionProbe',
    },
    options,
  )
  const shop = safeRecord(data.shop)
  const installation = safeRecord(data.currentAppInstallation)
  const shopId = shop?.id
  if (!shop || typeof shopId !== 'string' || !SHOPIFY_SHOP_GID_PATTERN.test(shopId)) {
    throw new ShopifyCommerceClientError(
      'Shopify returned invalid store identity data',
      502,
      'SHOPIFY_PROBE_INVALID',
    )
  }

  let shopDomain: string
  try {
    shopDomain = normalizeShopifyShopDomain(shop.myshopifyDomain)
  } catch {
    throw new ShopifyCommerceClientError(
      'Shopify returned invalid store identity data',
      502,
      'SHOPIFY_PROBE_INVALID',
    )
  }
  if (shopDomain !== requestedDomain || !installation) {
    throw new ShopifyCommerceClientError(
      'Shopify returned invalid store identity data',
      502,
      'SHOPIFY_PROBE_INVALID',
    )
  }

  return {
    provider: 'shopify',
    apiVersion: SHOPIFY_ADMIN_API_VERSION,
    shopId,
    shopDomain,
    shopName: probeShopName(shop.name),
    grantedScopes: probeGrantedScopes(installation.accessScopes),
  }
}

export const verifyShopifyConnection = probeShopifyConnection

export type ShopifyWebhookVerificationInput = {
  rawBody: string | Uint8Array
  hmac: unknown
  clientSecret: unknown
}

export function verifyShopifyWebhookHmac(input: ShopifyWebhookVerificationInput): boolean {
  if (
    typeof input.clientSecret !== 'string'
    || input.clientSecret.length < 16
    || input.clientSecret.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(input.clientSecret)
  ) {
    return false
  }
  const body = typeof input.rawBody === 'string'
    ? Buffer.from(input.rawBody, 'utf8')
    : Buffer.from(input.rawBody)
  if (body.byteLength > MAX_WEBHOOK_BYTES) return false

  const expected = crypto
    .createHmac('sha256', input.clientSecret)
    .update(body)
    .digest()
  const candidate = Buffer.alloc(expected.byteLength)
  const provided = typeof input.hmac === 'string' ? input.hmac.trim() : ''
  let validEncoding = false
  if (/^[A-Za-z0-9+/]{43}=$/.test(provided)) {
    const decoded = Buffer.from(provided, 'base64')
    if (decoded.byteLength === expected.byteLength && decoded.toString('base64') === provided) {
      decoded.copy(candidate)
      validEncoding = true
    }
  }

  const matches = crypto.timingSafeEqual(expected, candidate)
  return validEncoding && matches
}

export const verifyShopifyWebhookSignature = verifyShopifyWebhookHmac
