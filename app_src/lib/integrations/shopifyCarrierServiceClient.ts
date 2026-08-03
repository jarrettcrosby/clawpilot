import { SHOPIFY_ADMIN_API_VERSION } from '@/lib/integrations/commerceCapabilities'
import {
  shopifyAdminGraphql,
  ShopifyCommerceClientError,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'

const CARRIER_SERVICE_GID_PATTERN =
  /^gid:\/\/shopify\/DeliveryCarrierService\/[1-9][0-9]*$/
const PUBLIC_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const CARRIER_SERVICE_LIST_PAGE_SIZE = 250
const CARRIER_SERVICE_LIST_MAXIMUM_PAGES = 8

export const SHOPIFY_CARRIER_SERVICE_API_VERSION = SHOPIFY_ADMIN_API_VERSION

export type ShopifyCarrierService = {
  id: string
  name: string
  callbackUrl: string | null
  active: boolean
  supportsServiceDiscovery: boolean
}

export type ShopifyCarrierServiceCreateInput = {
  name: string
  callbackUrl: string
  active: boolean
  supportsServiceDiscovery: boolean
}

export type ShopifyCarrierServiceUpdateInput = {
  id: string
  name?: string
  callbackUrl?: string
  active?: boolean
  supportsServiceDiscovery?: boolean
}

export type ShopifyCarrierServiceUserError = {
  field: string[]
  message: string
}

export class ShopifyCarrierServiceClientError extends ShopifyCommerceClientError {
  readonly userErrors: ShopifyCarrierServiceUserError[]

  constructor(
    message: string,
    status: number,
    code: string,
    userErrors: ShopifyCarrierServiceUserError[] = [],
  ) {
    super(message, status, code, false)
    this.name = 'ShopifyCarrierServiceClientError'
    this.userErrors = userErrors
  }
}

function clientError(
  message: string,
  status: number,
  code: string,
  userErrors: ShopifyCarrierServiceUserError[] = [],
): never {
  throw new ShopifyCarrierServiceClientError(message, status, code, userErrors)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function carrierServiceId(value: unknown): string {
  if (typeof value !== 'string' || !CARRIER_SERVICE_GID_PATTERN.test(value)) {
    clientError(
      'A valid Shopify DeliveryCarrierService ID is required',
      400,
      'SHOPIFY_CARRIER_SERVICE_ID_INVALID',
    )
  }
  return value
}

function serviceName(value: unknown): string {
  if (typeof value !== 'string') {
    clientError(
      'A carrier service name is required',
      400,
      'SHOPIFY_CARRIER_SERVICE_NAME_INVALID',
    )
  }
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  if (
    !normalized
    || normalized.length > 255
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    clientError(
      'Carrier service name is invalid or too long',
      400,
      'SHOPIFY_CARRIER_SERVICE_NAME_INVALID',
    )
  }
  return normalized
}

function publicCallbackUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048 || value !== value.trim()) {
    clientError(
      'A public HTTPS carrier callback URL is required',
      400,
      'SHOPIFY_CARRIER_SERVICE_CALLBACK_INVALID',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    clientError(
      'A public HTTPS carrier callback URL is required',
      400,
      'SHOPIFY_CARRIER_SERVICE_CALLBACK_INVALID',
    )
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.hostname === 'localhost'
    || !PUBLIC_HOSTNAME_PATTERN.test(parsed.hostname)
  ) {
    clientError(
      'Carrier callback URL must be a public HTTPS URL without credentials or a fragment',
      400,
      'SHOPIFY_CARRIER_SERVICE_CALLBACK_INVALID',
    )
  }
  return parsed.toString()
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    clientError(
      `${field} must be boolean`,
      400,
      'SHOPIFY_CARRIER_SERVICE_INPUT_INVALID',
    )
  }
  return value
}

function normalizeCreateInput(
  value: unknown,
): ShopifyCarrierServiceCreateInput {
  const input = record(value)
  if (!input) {
    clientError(
      'Carrier service create input is required',
      400,
      'SHOPIFY_CARRIER_SERVICE_INPUT_INVALID',
    )
  }
  return {
    name: serviceName(input.name),
    callbackUrl: publicCallbackUrl(input.callbackUrl),
    active: booleanValue(input.active, 'active'),
    supportsServiceDiscovery: booleanValue(
      input.supportsServiceDiscovery,
      'supportsServiceDiscovery',
    ),
  }
}

function normalizeUpdateInput(
  value: unknown,
): ShopifyCarrierServiceUpdateInput {
  const input = record(value)
  if (!input) {
    clientError(
      'Carrier service update input is required',
      400,
      'SHOPIFY_CARRIER_SERVICE_INPUT_INVALID',
    )
  }
  const normalized: ShopifyCarrierServiceUpdateInput = {
    id: carrierServiceId(input.id),
  }
  let changes = 0
  if (input.name !== undefined) {
    normalized.name = serviceName(input.name)
    changes += 1
  }
  if (input.callbackUrl !== undefined) {
    normalized.callbackUrl = publicCallbackUrl(input.callbackUrl)
    changes += 1
  }
  if (input.active !== undefined) {
    normalized.active = booleanValue(input.active, 'active')
    changes += 1
  }
  if (input.supportsServiceDiscovery !== undefined) {
    normalized.supportsServiceDiscovery = booleanValue(
      input.supportsServiceDiscovery,
      'supportsServiceDiscovery',
    )
    changes += 1
  }
  if (!changes) {
    clientError(
      'Carrier service update requires at least one changed field',
      400,
      'SHOPIFY_CARRIER_SERVICE_UPDATE_EMPTY',
    )
  }
  return normalized
}

function userErrors(
  value: unknown,
  operation: 'create' | 'update' | 'delete',
): ShopifyCarrierServiceUserError[] {
  if (!Array.isArray(value) || value.length > 32) {
    clientError(
      'Shopify returned an invalid CarrierService response',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
  const errors = value.map((entry) => {
    const error = record(entry)
    if (
      !error
      || (
        error.field !== null
        && !Array.isArray(error.field)
      )
      || (
        Array.isArray(error.field)
        && error.field.length > 16
      )
      || typeof error.message !== 'string'
      || !error.message.trim()
      || error.message.length > 1_000
    ) {
      clientError(
        'Shopify returned an invalid CarrierService response',
        502,
        'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
      )
    }
    const field = (error.field === null ? [] : error.field as unknown[]).map((part) => {
      if (
        typeof part !== 'string'
        || !part
        || part.length > 128
        || /[\u0000-\u001f\u007f]/.test(part)
      ) {
        clientError(
          'Shopify returned an invalid CarrierService response',
          502,
          'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
        )
      }
      return part
    })
    return {
      field,
      message: error.message.trim(),
    }
  })
  if (errors.length) {
    clientError(
      `Shopify rejected the carrier service ${operation}`,
      422,
      `SHOPIFY_CARRIER_SERVICE_${operation.toUpperCase()}_REJECTED`,
      errors,
    )
  }
  return errors
}

function responseCallbackUrl(value: unknown): string | null {
  if (value === null) return null
  try {
    return publicCallbackUrl(value)
  } catch {
    clientError(
      'Shopify returned an invalid CarrierService response',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
}

function carrierService(value: unknown): ShopifyCarrierService {
  const service = record(value)
  if (
    !service
    || typeof service.active !== 'boolean'
    || typeof service.supportsServiceDiscovery !== 'boolean'
  ) {
    clientError(
      'Shopify returned an invalid CarrierService response',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
  let id: string
  let name: string
  try {
    id = carrierServiceId(service.id)
    name = serviceName(service.name)
  } catch {
    clientError(
      'Shopify returned an invalid CarrierService response',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
  return {
    id,
    name,
    callbackUrl: responseCallbackUrl(service.callbackUrl),
    active: service.active,
    supportsServiceDiscovery: service.supportsServiceDiscovery,
  }
}

const CARRIER_SERVICE_FIELDS = `
  id
  name
  callbackUrl
  active
  supportsServiceDiscovery
`

const CARRIER_SERVICE_QUERY = `query ClawPilotCarrierService($id: ID!) {
  carrierService(id: $id) {
    ${CARRIER_SERVICE_FIELDS}
  }
}`

const CARRIER_SERVICES_QUERY = `query ClawPilotCarrierServices(
  $first: Int!
  $after: String
) {
  carrierServices(first: $first, after: $after) {
    nodes {
      ${CARRIER_SERVICE_FIELDS}
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

const CARRIER_SERVICE_CREATE = `mutation ClawPilotCarrierServiceCreate(
  $input: DeliveryCarrierServiceCreateInput!
) {
  carrierServiceCreate(input: $input) {
    carrierService {
      ${CARRIER_SERVICE_FIELDS}
    }
    userErrors {
      field
      message
    }
  }
}`

const CARRIER_SERVICE_UPDATE = `mutation ClawPilotCarrierServiceUpdate(
  $input: DeliveryCarrierServiceUpdateInput!
) {
  carrierServiceUpdate(input: $input) {
    carrierService {
      ${CARRIER_SERVICE_FIELDS}
    }
    userErrors {
      field
      message
    }
  }
}`

const CARRIER_SERVICE_DELETE = `mutation ClawPilotCarrierServiceDelete($id: ID!) {
  carrierServiceDelete(id: $id) {
    deletedId
    userErrors {
      field
      message
    }
  }
}`

export async function queryShopifyCarrierService(
  credential: ShopifyCommerceRuntimeCredential,
  id: unknown,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyCarrierService | null> {
  const normalizedId = carrierServiceId(id)
  const data = await shopifyAdminGraphql<{ carrierService?: unknown }>(
    credential,
    {
      query: CARRIER_SERVICE_QUERY,
      variables: { id: normalizedId },
      operationName: 'ClawPilotCarrierService',
    },
    options,
  )
  const response = record(data)
  if (!response || response.carrierService === undefined) {
    clientError(
      'Shopify returned an invalid CarrierService query response',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
  if (response.carrierService === null) return null
  const service = carrierService(response.carrierService)
  if (service.id !== normalizedId) {
    clientError(
      'Shopify returned a different CarrierService than requested',
      502,
      'SHOPIFY_CARRIER_SERVICE_ID_MISMATCH',
    )
  }
  return service
}

/**
 * Enumerate the shop's complete CarrierService collection for read-only
 * reconciliation. A partial or malformed traversal fails closed so absence
 * can never be inferred from an incomplete provider response.
 */
export async function listShopifyCarrierServices(
  credential: ShopifyCommerceRuntimeCredential,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyCarrierService[]> {
  const services: ShopifyCarrierService[] = []
  const observedIds = new Set<string>()
  const observedCursors = new Set<string>()
  let after: string | null = null

  for (
    let page = 0;
    page < CARRIER_SERVICE_LIST_MAXIMUM_PAGES;
    page += 1
  ) {
    const data = await shopifyAdminGraphql<{
      carrierServices?: unknown
    }>(
      credential,
      {
        query: CARRIER_SERVICES_QUERY,
        variables: {
          first: CARRIER_SERVICE_LIST_PAGE_SIZE,
          after,
        },
        operationName: 'ClawPilotCarrierServices',
      },
      options,
    )
    const response = record(data)
    const connection = record(response?.carrierServices)
    const pageInfo = record(connection?.pageInfo)
    if (
      !connection
      || !Array.isArray(connection.nodes)
      || connection.nodes.length > CARRIER_SERVICE_LIST_PAGE_SIZE
      || !pageInfo
      || typeof pageInfo.hasNextPage !== 'boolean'
      || (
        pageInfo.endCursor !== null
        && typeof pageInfo.endCursor !== 'string'
      )
    ) {
      clientError(
        'Shopify returned an invalid CarrierService list response',
        502,
        'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
      )
    }

    for (const node of connection.nodes) {
      const service = carrierService(node)
      if (observedIds.has(service.id)) {
        clientError(
          'Shopify returned duplicate CarrierService identities',
          502,
          'SHOPIFY_CARRIER_SERVICE_LIST_INCOMPLETE',
        )
      }
      observedIds.add(service.id)
      services.push(service)
    }

    if (!pageInfo.hasNextPage) {
      return services
    }
    if (
      typeof pageInfo.endCursor !== 'string'
      || !pageInfo.endCursor
      || pageInfo.endCursor.length > 1_024
      || /[\u0000-\u001f\u007f]/.test(pageInfo.endCursor)
      || observedCursors.has(pageInfo.endCursor)
    ) {
      clientError(
        'Shopify CarrierService enumeration was incomplete',
        502,
        'SHOPIFY_CARRIER_SERVICE_LIST_INCOMPLETE',
      )
    }
    observedCursors.add(pageInfo.endCursor)
    after = pageInfo.endCursor
  }

  clientError(
    'Shopify CarrierService enumeration exceeded its safety bound',
    502,
    'SHOPIFY_CARRIER_SERVICE_LIST_INCOMPLETE',
  )
}

export async function createShopifyCarrierService(
  credential: ShopifyCommerceRuntimeCredential,
  input: unknown,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyCarrierService> {
  const normalized = normalizeCreateInput(input)
  const data = await shopifyAdminGraphql<{
    carrierServiceCreate?: unknown
  }>(
    credential,
    {
      query: CARRIER_SERVICE_CREATE,
      variables: { input: normalized },
      operationName: 'ClawPilotCarrierServiceCreate',
    },
    options,
  )
  const response = record(data)
  const payload = record(response?.carrierServiceCreate)
  if (!payload) {
    clientError(
      'Shopify returned an invalid CarrierService create response',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
  userErrors(payload.userErrors, 'create')
  const service = carrierService(payload.carrierService)
  if (service.callbackUrl === null) {
    clientError(
      'Shopify returned a CarrierService without its callback URL',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
  return service
}

export async function updateShopifyCarrierService(
  credential: ShopifyCommerceRuntimeCredential,
  input: unknown,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyCarrierService> {
  const normalized = normalizeUpdateInput(input)
  const data = await shopifyAdminGraphql<{
    carrierServiceUpdate?: unknown
  }>(
    credential,
    {
      query: CARRIER_SERVICE_UPDATE,
      variables: { input: normalized },
      operationName: 'ClawPilotCarrierServiceUpdate',
    },
    options,
  )
  const response = record(data)
  const payload = record(response?.carrierServiceUpdate)
  if (!payload) {
    clientError(
      'Shopify returned an invalid CarrierService update response',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
  userErrors(payload.userErrors, 'update')
  const service = carrierService(payload.carrierService)
  if (service.id !== normalized.id) {
    clientError(
      'Shopify returned a different CarrierService than updated',
      502,
      'SHOPIFY_CARRIER_SERVICE_ID_MISMATCH',
    )
  }
  return service
}

export async function deleteShopifyCarrierService(
  credential: ShopifyCommerceRuntimeCredential,
  id: unknown,
  options: ShopifyCommerceClientOptions = {},
): Promise<string> {
  const normalizedId = carrierServiceId(id)
  const data = await shopifyAdminGraphql<{
    carrierServiceDelete?: unknown
  }>(
    credential,
    {
      query: CARRIER_SERVICE_DELETE,
      variables: { id: normalizedId },
      operationName: 'ClawPilotCarrierServiceDelete',
    },
    options,
  )
  const response = record(data)
  const payload = record(response?.carrierServiceDelete)
  if (!payload) {
    clientError(
      'Shopify returned an invalid CarrierService delete response',
      502,
      'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
    )
  }
  userErrors(payload.userErrors, 'delete')
  const deletedId = carrierServiceId(payload.deletedId)
  if (deletedId !== normalizedId) {
    clientError(
      'Shopify returned a different deleted CarrierService than requested',
      502,
      'SHOPIFY_CARRIER_SERVICE_ID_MISMATCH',
    )
  }
  return deletedId
}
