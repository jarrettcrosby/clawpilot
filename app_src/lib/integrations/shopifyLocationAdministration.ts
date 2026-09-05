import { createHash } from 'node:crypto'
import {
  decryptCommerceCredential,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  hasEffectiveShopifyScope,
  SHOPIFY_ADMIN_API_VERSION,
  type ShopifyAccessScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  ShopifyCommerceClientError,
  shopifyAdminGraphql,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  shopifyLocationAdministrationAccountAllowed,
  shopifyLocationAdministrationRuntime,
} from '@/lib/integrations/shopifyLocationAdministrationRuntime'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  claimShopifyLocationAdministrationInPostgres,
  prepareShopifyLocationAdministrationInPostgres,
  readPendingShopifyLocationAdministrationsInPostgres,
  readShopifyLocationAdministrationAuthorizationInPostgres,
  readShopifyLocationAdministrationConfigurationInPostgres,
  recordShopifyLocationAdministrationOutcomeInPostgres,
  recoverStaleShopifyLocationAdministrationInPostgres,
  reconcileShopifyLocationAdministrationAppliedInPostgres,
  ShopifyLocationAdministrationPersistenceError,
  type ShopifyLocationAdministrationAction,
  type ShopifyLocationAdministrationAuthorization,
  type ShopifyLocationAdministrationDesiredLocation,
} from '@/lib/persistence/shopifyLocationAdministration'
import {
  readCommerceRuntimeCredentialFromPostgres,
  type CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'

export const SHOPIFY_LOCATION_ADMINISTRATION_ADAPTER_VERSION =
  'shopify-location-administration-2026-07-v1' as const

if (SHOPIFY_ADMIN_API_VERSION !== '2026-07') {
  throw new Error('Shopify location administration requires Admin API 2026-07')
}

const LOCATION_GID = /^gid:\/\/shopify\/Location\/[1-9][0-9]{0,20}$/u
const SHOP_GID = /^gid:\/\/shopify\/Shop\/[1-9][0-9]{0,20}$/u
const AUTHORIZATION_GLOBAL_ID = /^gsla(?:[0-9]{7}|[0-9a-v]{12})$/u
const ATTEMPT_GLOBAL_ID = /^gslt(?:[0-9]{7}|[0-9a-v]{12})$/u
const MAPPING_GLOBAL_ID = /^gilm(?:[0-9]{7}|[0-9a-v]{12})$/u
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const REQUIRED_SCOPES = Object.freeze([
  'read_locations',
  'write_locations',
] as const satisfies readonly ShopifyAccessScope[])
const MAX_LOCATION_PAGES = 5
const LOCATION_PAGE_SIZE = 50

export type ShopifyLocationAdministrationAddress = Readonly<{
  address1: string
  address2: string
  city: string
  provinceCode: string
  countryCode: string
  zip: string
}>

export type ShopifyLocationAdministrationProviderLocation = Readonly<{
  id: string
  name: string
  isActive: boolean
  activatable: boolean
  shipsInventory: boolean
  fulfillsOnlineOrders: boolean
  isFulfillmentService: boolean
  fulfillmentService: Readonly<{
    id: string
    handle: string
    serviceName: string
  }> | null
  address: ShopifyLocationAdministrationAddress
}>

export type ShopifyLocationAdministrationShop = Readonly<{
  id: string
  domain: string
  name: string
  partnerDevelopment: true
  planName: string
}>

export type ShopifyLocationAdministrationUserError = Readonly<{
  field: readonly string[]
  code: string | null
  messageHash: string
}>

export type ShopifyLocationAdministrationProviderResult = Readonly<{
  action: ShopifyLocationAdministrationAction
  outcome: 'succeeded' | 'rejected' | 'unknown'
  location: ShopifyLocationAdministrationProviderLocation | null
  providerMutationAttempted: true
  providerWritesKnown: boolean
  providerWrites: 0 | 1 | null
  userErrors: readonly ShopifyLocationAdministrationUserError[]
  errorCode: string | null
}>

export class ShopifyLocationAdministrationError extends Error {
  readonly code: string
  readonly status: number
  readonly uncertain: boolean
  readonly providerMutationAttempted: boolean

  constructor(input: {
    code: string
    message: string
    status?: number
    uncertain?: boolean
    providerMutationAttempted?: boolean
  }) {
    super(input.message)
    this.name = 'ShopifyLocationAdministrationError'
    this.code = input.code
    this.status = input.status || 409
    this.uncertain = Boolean(input.uncertain)
    this.providerMutationAttempted = Boolean(
      input.providerMutationAttempted,
    )
  }
}

type Graphql = typeof shopifyAdminGraphql

type ProviderDependencies = Readonly<{
  graphql: Graphql
}>

const DEFAULT_PROVIDER_DEPENDENCIES: ProviderDependencies = Object.freeze({
  graphql: shopifyAdminGraphql,
})

const LOCATION_FIELDS = `
  id
  name
  isActive
  activatable
  shipsInventory
  fulfillsOnlineOrders
  isFulfillmentService
  fulfillmentService {
    id
    handle
    serviceName
  }
  address {
    address1
    address2
    city
    provinceCode
    countryCode
    zip
  }`

const LOCATION_QUERY = `query ClawPilotLocationAdministrationLocation(
  $id: ID!
) {
  node(id: $id) {
    ... on Location {
      ${LOCATION_FIELDS}
    }
  }
}`

const LOCATIONS_QUERY = `query ClawPilotLocationAdministrationLocations(
  $first: Int!
  $after: String
) {
  locations(
    first: $first
    after: $after
    includeInactive: true
    includeLegacy: true
  ) {
    nodes {
      ${LOCATION_FIELDS}
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

const DEVELOPMENT_SHOP_QUERY = `query ClawPilotLocationAdministrationShop {
  shop {
    id
    name
    myshopifyDomain
    plan {
      partnerDevelopment
      publicDisplayName
    }
  }
}`

const LOCATION_ADD_MUTATION = `mutation ClawPilotLocationAdd(
  $input: LocationAddInput!
) {
  locationAdd(input: $input) {
    location {
      ${LOCATION_FIELDS}
    }
    userErrors {
      field
      message
      code
    }
  }
}`

const LOCATION_EDIT_MUTATION = `mutation ClawPilotLocationEdit(
  $id: ID!
  $input: LocationEditInput!
) {
  locationEdit(id: $id, input: $input) {
    location {
      ${LOCATION_FIELDS}
    }
    userErrors {
      field
      message
      code
    }
  }
}`

// The stable key is persisted before dispatch and is passed unchanged through
// Shopify's 2026-01+ @idempotent directive. No other action claims provider
// idempotency support.
const LOCATION_ACTIVATE_MUTATION = `mutation ClawPilotLocationActivate(
  $locationId: ID!
  $idempotencyKey: String!
) {
  locationActivate(locationId: $locationId)
    @idempotent(key: $idempotencyKey) {
    location {
      ${LOCATION_FIELDS}
    }
    locationActivateUserErrors {
      field
      message
      code
    }
  }
}`

function fail(
  code: string,
  message: string,
  status = 409,
  input: { uncertain?: boolean; providerMutationAttempted?: boolean } = {},
): never {
  throw new ShopifyLocationAdministrationError({
    code,
    message,
    status,
    ...input,
  })
}

function record(value: unknown, label = 'Shopify response') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      `${label} was invalid`,
      502,
    )
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum: number) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
    )
  }
  return value
}

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === null || value === undefined || value === '') return ''
  return text(value, label, maximum)
}

function boolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
    )
  }
  return value
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_INVALID',
        'Shopify location evidence was invalid',
        500,
      )
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_INVALID',
      'Shopify location evidence was invalid',
      500,
    )
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`
    }
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key], ancestors)}`
    )).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function shopifyLocationAdministrationHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function address(value: unknown): ShopifyLocationAdministrationAddress {
  const source = record(value, 'Shopify location address')
  const countryCode = text(
    source.countryCode,
    'location country code',
    2,
  ).toUpperCase()
  if (!/^[A-Z]{2}$/u.test(countryCode)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      'Shopify returned an invalid location country code',
      502,
    )
  }
  return Object.freeze({
    address1: optionalText(source.address1, 'location address line 1', 255),
    address2: optionalText(source.address2, 'location address line 2', 255),
    city: optionalText(source.city, 'location city', 255),
    provinceCode: optionalText(
      source.provinceCode,
      'location province code',
      64,
    ).toUpperCase(),
    countryCode,
    zip: optionalText(source.zip, 'location postal code', 64),
  })
}

export function normalizeShopifyLocationAdministrationLocation(
  value: unknown,
): ShopifyLocationAdministrationProviderLocation {
  const source = record(value, 'Shopify location')
  const id = text(source.id, 'location ID', 255)
  if (!LOCATION_GID.test(id)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      'Shopify returned an invalid location ID',
      502,
    )
  }
  let fulfillmentService:
    ShopifyLocationAdministrationProviderLocation['fulfillmentService'] = null
  if (source.fulfillmentService !== null && source.fulfillmentService !== undefined) {
    const service = record(
      source.fulfillmentService,
      'Shopify fulfillment service',
    )
    fulfillmentService = Object.freeze({
      id: text(service.id, 'fulfillment service ID', 255),
      handle: text(service.handle, 'fulfillment service handle', 255),
      serviceName: text(
        service.serviceName,
        'fulfillment service name',
        255,
      ),
    })
  }
  const providerMarksFulfillmentService = boolean(
    source.isFulfillmentService,
    'fulfillment-service state',
  )
  // Any provider evidence of fulfillment-service ownership wins. A missing
  // service object (for example because a legacy service is no longer
  // readable) must not downgrade Shopify's explicit ownership flag and make
  // the location writable.
  const isFulfillmentService = providerMarksFulfillmentService
    || Boolean(fulfillmentService)
  return Object.freeze({
    id,
    name: text(source.name, 'location name', 255),
    isActive: boolean(source.isActive, 'location active state'),
    activatable: boolean(source.activatable, 'location activatable state'),
    shipsInventory: boolean(
      source.shipsInventory,
      'location ships-inventory state',
    ),
    fulfillsOnlineOrders: boolean(
      source.fulfillsOnlineOrders,
      'location online-fulfillment state',
    ),
    isFulfillmentService,
    fulfillmentService,
    address: address(source.address),
  })
}

function locationHash(location: ShopifyLocationAdministrationProviderLocation) {
  return shopifyLocationAdministrationHash({
    schema: 'shopify-location-snapshot-v1',
    location,
  })
}

export function shopifyLocationAdministrationLocationSetHash(
  locations: readonly ShopifyLocationAdministrationProviderLocation[],
) {
  return shopifyLocationAdministrationHash({
    schema: 'shopify-location-set-v1',
    locations: [...locations]
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
}

function connection(value: unknown) {
  const source = record(value, 'Shopify locations connection')
  if (!Array.isArray(source.nodes)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      'Shopify returned invalid locations',
      502,
    )
  }
  const pageInfo = record(source.pageInfo, 'Shopify locations page info')
  const hasNextPage = boolean(pageInfo.hasNextPage, 'locations page state')
  const endCursor = pageInfo.endCursor === null
    ? null
    : text(pageInfo.endCursor, 'locations cursor', 2048)
  if (hasNextPage && !endCursor) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      'Shopify returned an invalid locations cursor',
      502,
    )
  }
  return {
    locations: source.nodes.map(
      normalizeShopifyLocationAdministrationLocation,
    ),
    hasNextPage,
    endCursor,
  }
}

export async function readShopifyLocationAdministrationLocation(
  credential: ShopifyCommerceRuntimeCredential,
  providerLocationId: unknown,
  options: ShopifyCommerceClientOptions = {},
  dependencies: Partial<ProviderDependencies> = {},
) {
  const id = String(providerLocationId || '').trim()
  if (!LOCATION_GID.test(id)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_INVALID',
      'A valid Shopify location is required',
      400,
    )
  }
  const data = await (dependencies.graphql || shopifyAdminGraphql)<{
    node?: unknown
  }>(credential, {
    query: LOCATION_QUERY,
    operationName: 'ClawPilotLocationAdministrationLocation',
    variables: { id },
  }, options)
  if (!data.node) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_NOT_FOUND',
      'The Shopify location no longer exists',
      404,
    )
  }
  const location = normalizeShopifyLocationAdministrationLocation(data.node)
  if (location.id !== id) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_CHANGED',
      'Shopify returned a different location identity',
      409,
    )
  }
  return location
}

export async function listShopifyLocationAdministrationLocations(
  credential: ShopifyCommerceRuntimeCredential,
  options: ShopifyCommerceClientOptions = {},
  dependencies: Partial<ProviderDependencies> = {},
) {
  const graphql = dependencies.graphql || shopifyAdminGraphql
  const locations: ShopifyLocationAdministrationProviderLocation[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
    const data = await graphql<{ locations?: unknown }>(credential, {
      query: LOCATIONS_QUERY,
      operationName: 'ClawPilotLocationAdministrationLocations',
      variables: { first: LOCATION_PAGE_SIZE, after },
    }, options)
    const parsed = connection(data.locations)
    locations.push(...parsed.locations)
    if (!parsed.hasNextPage) return Object.freeze(locations)
    after = parsed.endCursor
  }
  fail(
    'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_LIMIT_EXCEEDED',
    'This store has more locations than the bounded administration lane supports',
    409,
  )
}

export async function readShopifyLocationAdministrationShop(
  credential: ShopifyCommerceRuntimeCredential,
  options: ShopifyCommerceClientOptions = {},
  dependencies: Partial<ProviderDependencies> = {},
): Promise<ShopifyLocationAdministrationShop> {
  const data = await (dependencies.graphql || shopifyAdminGraphql)<{
    shop?: unknown
  }>(credential, {
    query: DEVELOPMENT_SHOP_QUERY,
    operationName: 'ClawPilotLocationAdministrationShop',
  }, options)
  const shop = record(data.shop, 'Shopify store')
  const plan = record(shop.plan, 'Shopify store plan')
  const id = text(shop.id, 'store ID', 255)
  if (!SHOP_GID.test(id)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      'Shopify returned an invalid store ID',
      502,
    )
  }
  if (plan.partnerDevelopment !== true) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_DEVELOPMENT_STORE_REQUIRED',
      'Shopify location administration is limited to a Partner development store',
      409,
    )
  }
  return Object.freeze({
    id,
    domain: normalizeShopifyShopDomain(shop.myshopifyDomain),
    name: text(shop.name, 'store name', 255),
    partnerDevelopment: true,
    planName: text(plan.publicDisplayName, 'store plan', 255),
  })
}

function providerInput(desired: ShopifyLocationAdministrationDesiredLocation) {
  return {
    name: desired.name,
    address: {
      address1: desired.address.address1 || undefined,
      address2: desired.address.address2 || undefined,
      city: desired.address.city || undefined,
      provinceCode: desired.address.provinceCode || undefined,
      countryCode: desired.address.countryCode,
      zip: desired.address.zip || undefined,
    },
    fulfillsOnlineOrders: true,
  }
}

function userErrors(value: unknown): ShopifyLocationAdministrationUserError[] {
  if (!Array.isArray(value) || value.length > 50) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
      'Shopify returned invalid location errors',
      502,
    )
  }
  return value.map((entry) => {
    const error = record(entry, 'Shopify location user error')
    if (!Array.isArray(error.field) || error.field.length > 20) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
        'Shopify returned an invalid location error field',
        502,
      )
    }
    const message = text(error.message, 'location error message', 2_000)
    return Object.freeze({
      field: Object.freeze(error.field.map((part) => (
        text(part, 'location error field', 255)
      ))),
      code: error.code === null || error.code === undefined
        ? null
        : text(error.code, 'location error code', 128),
      messageHash: shopifyLocationAdministrationHash({ message }),
    })
  })
}

function equivalentAddress(
  left: ShopifyLocationAdministrationAddress,
  right: ShopifyLocationAdministrationAddress,
) {
  return canonicalJson(left) === canonicalJson(right)
}

export function shopifyLocationMatchesDesired(
  location: ShopifyLocationAdministrationProviderLocation,
  desired: ShopifyLocationAdministrationDesiredLocation,
) {
  return !location.isFulfillmentService
    && location.name === desired.name
    && location.fulfillsOnlineOrders
    && equivalentAddress(location.address, desired.address)
}

function mutationPayload(
  data: Record<string, unknown>,
  action: ShopifyLocationAdministrationAction,
) {
  if (action === 'locationAdd') {
    const payload = record(data.locationAdd, 'Shopify locationAdd result')
    return {
      location: payload.location,
      errors: userErrors(payload.userErrors),
    }
  }
  if (action === 'locationEdit') {
    const payload = record(data.locationEdit, 'Shopify locationEdit result')
    return {
      location: payload.location,
      errors: userErrors(payload.userErrors),
    }
  }
  const payload = record(
    data.locationActivate,
    'Shopify locationActivate result',
  )
  return {
    location: payload.location,
    errors: userErrors(payload.locationActivateUserErrors),
  }
}

export async function executeShopifyLocationAdministrationProviderMutation(
  input: {
    credential: ShopifyCommerceRuntimeCredential
    action: ShopifyLocationAdministrationAction
    desired: ShopifyLocationAdministrationDesiredLocation
    providerLocationId: string | null
    providerIdempotencyKey: string
    clientOptions?: ShopifyCommerceClientOptions
  },
  dependencies: Partial<ProviderDependencies> = {},
): Promise<ShopifyLocationAdministrationProviderResult> {
  const graphql = dependencies.graphql || DEFAULT_PROVIDER_DEPENDENCIES.graphql
  let request: {
    query: string
    operationName: string
    variables: Record<string, unknown>
  }
  if (input.action === 'locationAdd') {
    if (input.providerLocationId !== null) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_REQUEST_INVALID',
        'locationAdd cannot target an existing Shopify location',
        400,
      )
    }
    request = {
      query: LOCATION_ADD_MUTATION,
      operationName: 'ClawPilotLocationAdd',
      variables: { input: providerInput(input.desired) },
    }
  } else {
    if (!LOCATION_GID.test(input.providerLocationId || '')) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_REQUEST_INVALID',
        'A valid Shopify location is required',
        400,
      )
    }
    request = input.action === 'locationEdit'
      ? {
          query: LOCATION_EDIT_MUTATION,
          operationName: 'ClawPilotLocationEdit',
          variables: {
            id: input.providerLocationId,
            input: providerInput(input.desired),
          },
        }
      : {
          query: LOCATION_ACTIVATE_MUTATION,
          operationName: 'ClawPilotLocationActivate',
          variables: {
            locationId: input.providerLocationId,
            idempotencyKey: input.providerIdempotencyKey,
          },
        }
  }

  let data: Record<string, unknown>
  try {
    data = await graphql<Record<string, unknown>>(
      input.credential,
      request,
      input.clientOptions,
    )
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    const code = error instanceof ShopifyCommerceClientError
      && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.code)
      ? error.code
      : 'SHOPIFY_LOCATION_ADMINISTRATION_OUTCOME_UNKNOWN'
    return Object.freeze({
      action: input.action,
      outcome: 'unknown',
      location: null,
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWrites: null,
      userErrors: Object.freeze([]),
      errorCode: code,
    })
  }

  const payload = mutationPayload(data, input.action)
  if (payload.errors.length) {
    return Object.freeze({
      action: input.action,
      outcome: 'rejected',
      location: null,
      providerMutationAttempted: true,
      providerWritesKnown: true,
      providerWrites: 0,
      userErrors: Object.freeze(payload.errors),
      errorCode: 'SHOPIFY_LOCATION_ADMINISTRATION_USER_ERROR',
    })
  }

  let returned: ShopifyLocationAdministrationProviderLocation
  try {
    returned = normalizeShopifyLocationAdministrationLocation(payload.location)
  } catch {
    return Object.freeze({
      action: input.action,
      outcome: 'unknown',
      location: null,
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWrites: null,
      userErrors: Object.freeze([]),
      errorCode: 'SHOPIFY_LOCATION_ADMINISTRATION_RESPONSE_INVALID',
    })
  }
  if (returned.isFulfillmentService) {
    return Object.freeze({
      action: input.action,
      outcome: 'unknown',
      location: returned,
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWrites: null,
      userErrors: Object.freeze([]),
      errorCode: 'SHOPIFY_LOCATION_ADMINISTRATION_OWNERSHIP_UNCERTAIN',
    })
  }

  let readback: ShopifyLocationAdministrationProviderLocation
  try {
    readback = await readShopifyLocationAdministrationLocation(
      input.credential,
      returned.id,
      input.clientOptions,
      { graphql },
    )
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    return Object.freeze({
      action: input.action,
      outcome: 'unknown',
      location: returned,
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWrites: null,
      userErrors: Object.freeze([]),
      errorCode: 'SHOPIFY_LOCATION_ADMINISTRATION_READBACK_UNKNOWN',
    })
  }
  const applied = input.action === 'locationActivate'
    ? !readback.isFulfillmentService && readback.isActive
    : shopifyLocationMatchesDesired(readback, input.desired)
  if (!applied) {
    return Object.freeze({
      action: input.action,
      outcome: 'unknown',
      location: readback,
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWrites: null,
      userErrors: Object.freeze([]),
      errorCode: 'SHOPIFY_LOCATION_ADMINISTRATION_READBACK_MISMATCH',
    })
  }
  return Object.freeze({
    action: input.action,
    outcome: 'succeeded',
    location: readback,
    providerMutationAttempted: true,
    providerWritesKnown: true,
    providerWrites: 1,
    userErrors: Object.freeze([]),
    errorCode: null,
  })
}

function integrationError(error: unknown): ShopifyLocationAdministrationError {
  if (isIntegrationCredentialRuntimeGateError(error)) throw error
  if (error instanceof ShopifyLocationAdministrationError) return error
  if (error instanceof ShopifyLocationAdministrationPersistenceError) {
    return new ShopifyLocationAdministrationError({
      code: error.code,
      message: error.message,
      status: error.status,
    })
  }
  if (error instanceof ShopifyCommerceClientError) {
    return new ShopifyLocationAdministrationError({
      code: error.code,
      message: 'Shopify location administration could not read the provider',
      status: error.status,
    })
  }
  return new ShopifyLocationAdministrationError({
    code: 'SHOPIFY_LOCATION_ADMINISTRATION_INTERNAL_ERROR',
    message: 'Shopify location administration is temporarily unavailable',
    status: 500,
  })
}

function exactGlobalId(
  value: unknown,
  pattern: RegExp,
  label: string,
) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!pattern.test(normalized)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function idempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_IDEMPOTENCY_REQUIRED',
      'A stable idempotency key of 8-200 safe characters is required',
      400,
    )
  }
  return normalized
}

function reason(value: unknown) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 10
    || normalized.length > 500
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_REASON_REQUIRED',
      'An operator reason of 10-500 characters is required',
      400,
    )
  }
  return normalized
}

function rowVersion(value: unknown, label: string) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function action(value: unknown): ShopifyLocationAdministrationAction {
  if (
    value === 'locationAdd'
    || value === 'locationEdit'
    || value === 'locationActivate'
  ) return value
  fail(
    'SHOPIFY_LOCATION_ADMINISTRATION_ACTION_INVALID',
    'Supported Shopify location actions are add, edit, and activate',
    400,
  )
}

export function shopifyLocationAdministrationConfirmation(input: {
  action: ShopifyLocationAdministrationAction
  accountGlobalId: string
  warehouseGlobalId: string
  providerLocationId?: string | null
}) {
  const verb = input.action === 'locationAdd'
    ? 'ADD'
    : input.action === 'locationEdit'
      ? 'EDIT'
      : 'ACTIVATE'
  return [
    'AUTHORIZE SHOPIFY LOCATION',
    verb,
    input.accountGlobalId,
    input.warehouseGlobalId,
    input.providerLocationId || 'NEW',
  ].join(' | ')
}

function assertConfirmation(actual: unknown, expected: string) {
  if (actual !== expected) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_CONFIRMATION_MISMATCH',
      'Type the exact Shopify location authorization statement',
      409,
    )
  }
}

function assertMerchantManaged(
  location: ShopifyLocationAdministrationProviderLocation,
) {
  if (location.isFulfillmentService || location.fulfillmentService) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_FULFILLMENT_SERVICE_FORBIDDEN',
      'Fulfillment-service locations are read-only and cannot be claimed, edited, or activated by ClawPilot',
      409,
    )
  }
}

type ProviderContext = Readonly<{
  stored: CommerceRuntimeCredentialRecord
  credential: ShopifyCommerceRuntimeCredential
  shop: ShopifyLocationAdministrationShop
}>

async function providerContext(input: {
  organizationId: unknown
  accountGlobalId: unknown
}): Promise<ProviderContext> {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(
    input.accountGlobalId,
  )
  const runtimePolicy = shopifyLocationAdministrationRuntime()
  if (!runtimePolicy.available) {
    fail(
      runtimePolicy.blockerCode
        || 'SHOPIFY_LOCATION_ADMINISTRATION_DISABLED',
      'Shopify location administration is unavailable in this deployment',
      404,
    )
  }
  if (!shopifyLocationAdministrationAccountAllowed(accountGlobalId)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_NOT_ALLOWED',
      'This Shopify account is not allowlisted for location administration',
      403,
    )
  }
  const stored = await readCommerceRuntimeCredentialFromPostgres({
    organizationId,
    accountGlobalId,
  })
  if (
    !stored
    || stored.provider !== 'shopify'
    || stored.environment !== 'sandbox'
    || stored.status !== 'active'
    || stored.verificationStatus !== 'verified'
    || stored.authMode !== 'shopify_client_credentials'
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_SANDBOX_ACCOUNT_REQUIRED',
      'An active verified Shopify sandbox connection is required',
      409,
    )
  }
  const decrypted = decryptCommerceCredential(
    stored.encrypted,
    stored.organizationId,
    stored.provider,
    stored.environment,
    stored.externalAccountId,
  )
  if (decrypted.provider !== 'shopify') {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_CREDENTIAL_INVALID',
      'The verified Shopify credential could not be used',
      409,
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    stored.configuration.shopDomain,
  )
  const grant = await requestShopifyAccessToken({
    shopDomain,
    clientId: decrypted.clientId,
    clientSecret: decrypted.clientSecret,
  })
  const credential = {
    shopDomain,
    accessToken: grant.accessToken,
  }
  const probe = await probeShopifyConnection(credential)
  if (
    probe.shopId !== stored.externalAccountId
    || probe.shopDomain !== shopDomain
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_STORE_IDENTITY_CHANGED',
      'Shopify returned a different store identity',
      409,
    )
  }
  const missingScopes = REQUIRED_SCOPES.filter((scope) => (
    !hasEffectiveShopifyScope(grant.grantedScopes, scope)
    || !hasEffectiveShopifyScope(probe.grantedScopes, scope)
  ))
  if (missingScopes.length) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_SCOPE_REQUIRED',
      `Shopify location administration requires ${missingScopes.join(', ')}`,
      409,
    )
  }
  const shop = await readShopifyLocationAdministrationShop(credential)
  if (shop.id !== stored.externalAccountId || shop.domain !== shopDomain) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_STORE_IDENTITY_CHANGED',
      'Shopify returned a different development-store identity',
      409,
    )
  }
  return Object.freeze({ stored, credential, shop })
}

function desiredMatchesLocation(
  desired: ShopifyLocationAdministrationDesiredLocation,
  location: ShopifyLocationAdministrationProviderLocation,
) {
  return shopifyLocationMatchesDesired(location, desired)
}

export async function readShopifyLocationAdministrationState(input: {
  organizationId: unknown
  accountGlobalId: unknown
  actorEmail: unknown
}) {
  try {
    const context = await providerContext(input)
    const [configuration, locations, pendingAuthorizations] = await Promise.all([
      readShopifyLocationAdministrationConfigurationInPostgres({
        organizationId: context.stored.organizationId,
        accountGlobalId: context.stored.globalId,
      }),
      listShopifyLocationAdministrationLocations(context.credential),
      readPendingShopifyLocationAdministrationsInPostgres({
        organizationId: context.stored.organizationId,
        accountGlobalId: context.stored.globalId,
        actorEmail: input.actorEmail,
      }),
    ])
    const mappingsByProvider = new Map(
      configuration.mappings.map((mapping) => [
        mapping.providerLocationId,
        mapping,
      ]),
    )
    const warehousesByGlobal = new Map(
      configuration.warehouses.map((warehouse) => [
        warehouse.globalId,
        warehouse,
      ]),
    )
    const mappedWarehouses = new Set(
      configuration.mappings
        .filter((mapping) => mapping.active)
        .map((mapping) => mapping.warehouseGlobalId),
    )
    return Object.freeze({
      runtime: shopifyLocationAdministrationRuntime(),
      account: Object.freeze({
        globalId: context.stored.globalId,
        displayName: configuration.accountDisplayName,
        environment: 'sandbox' as const,
        shopId: context.shop.id,
        shopDomain: context.shop.domain,
        shopName: context.shop.name,
        partnerDevelopment: true as const,
        planName: context.shop.planName,
        credentialGeneration: context.stored.credentialVersion,
      }),
      providerLocations: Object.freeze(locations.map((location) => {
        const mapping = mappingsByProvider.get(location.id) || null
        const mappedWarehouse = mapping
          ? warehousesByGlobal.get(mapping.warehouseGlobalId) || null
          : null
        const readOnly = location.isFulfillmentService
        const allowedActions: ShopifyLocationAdministrationAction[] = []
        const editRequired = Boolean(
          mappedWarehouse?.desiredLocation
          && !shopifyLocationMatchesDesired(
            location,
            mappedWarehouse.desiredLocation,
          ),
        )
        if (
          !readOnly
          && mapping?.active
          && mappedWarehouse?.locationAdministrationReady
        ) {
          if (editRequired) allowedActions.push('locationEdit')
          if (!location.isActive && location.activatable) {
            if (!editRequired) allowedActions.push('locationActivate')
          }
        }
        return Object.freeze({
          ...location,
          ownership: readOnly
            ? 'fulfillment_service' as const
            : 'merchant_managed' as const,
          readOnly,
          readOnlyReason: readOnly
            ? 'Only the app that created this fulfillment service can edit its location.'
            : null,
          mapping,
          allowedActions: Object.freeze(allowedActions),
          editConfirmationStatement: !readOnly
            && mapping?.active
            && mappedWarehouse?.locationAdministrationReady
            && editRequired
            ? shopifyLocationAdministrationConfirmation({
                action: 'locationEdit',
                accountGlobalId: context.stored.globalId,
                warehouseGlobalId: mapping.warehouseGlobalId,
                providerLocationId: location.id,
              })
            : null,
          activateConfirmationStatement:
            !readOnly
              && mapping?.active
              && mappedWarehouse?.locationAdministrationReady
              && !location.isActive
              && location.activatable
              && !editRequired
              ? shopifyLocationAdministrationConfirmation({
                  action: 'locationActivate',
                  accountGlobalId: context.stored.globalId,
                  warehouseGlobalId: mapping.warehouseGlobalId,
                  providerLocationId: location.id,
                })
              : null,
          snapshotHash: locationHash(location),
        })
      })),
      warehouses: Object.freeze(configuration.warehouses.map((warehouse) => (
        (() => {
          const exactProviderMatches = warehouse.desiredLocation
            ? locations.filter((location) => (
                shopifyLocationMatchesDesired(
                  location,
                  warehouse.desiredLocation!,
                )
              ))
            : []
          const alreadyMapped = mappedWarehouses.has(warehouse.globalId)
          const canAddToShopify = warehouse.locationAdministrationReady
            && !alreadyMapped
            && !warehouse.hasActiveCommerceLocationRouting
            && exactProviderMatches.length === 0
          return Object.freeze({
            ...warehouse,
            canAddToShopify,
            addBlockerCode: canAddToShopify
              ? null
              : !warehouse.locationAdministrationReady
                ? warehouse.readinessBlockerCode
                : alreadyMapped
                  ? 'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_ALREADY_MAPPED'
                  : warehouse.hasActiveCommerceLocationRouting
                    ? 'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_ALREADY_MAPPED'
                  : 'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_ALREADY_EXISTS',
            exactProviderLocationIds: Object.freeze(
              exactProviderMatches.map((location) => location.id),
            ),
            addConfirmationStatement: canAddToShopify
              ? shopifyLocationAdministrationConfirmation({
                  action: 'locationAdd',
                  accountGlobalId: context.stored.globalId,
                  warehouseGlobalId: warehouse.globalId,
                })
              : null,
          })
        })()
      ))),
      mappings: Object.freeze(configuration.mappings),
      pendingAuthorizations: Object.freeze(
        pendingAuthorizations.map((authorization) => Object.freeze({
          authorizationGlobalId: authorization.authorizationGlobalId,
          attemptGlobalId: authorization.attemptGlobalId,
          action: authorization.action,
          status: authorization.status,
          warehouseGlobalId: authorization.warehouseGlobalId,
          mappingGlobalId: authorization.mappingGlobalId,
          providerLocationId: authorization.providerLocationId,
          idempotencyKey: authorization.idempotencyKey,
          preparedAt: authorization.preparedAt,
          expiresAt: authorization.expiresAt,
          processingAt: authorization.processingAt,
          nextAction: authorization.status === 'prepared'
            ? 'execute' as const
            : authorization.status === 'unknown'
              ? 'reconcile' as const
              : 'wait_then_reconcile' as const,
        })),
      ),
      uiContract: Object.freeze({
        endpoint:
          '/api/integrations/commerce/shopify/location-administration',
        state: Object.freeze({
          method: 'GET' as const,
          query: Object.freeze(['accountGlobalId'] as const),
        }),
        prepare: Object.freeze({
          method: 'POST' as const,
          header: 'Idempotency-Key' as const,
          action: 'prepare' as const,
          commonFields: Object.freeze([
            'accountGlobalId', 'mutation', 'warehouseGlobalId',
            'expectedWarehouseRowVersion', 'reason',
            'confirmationStatement',
          ] as const),
          mappedLocationFields: Object.freeze([
            'mappingGlobalId', 'expectedMappingRowVersion',
          ] as const),
        }),
        execute: Object.freeze({
          method: 'POST' as const,
          header: 'Idempotency-Key' as const,
          action: 'execute' as const,
          fields: Object.freeze(['authorizationGlobalId'] as const),
        }),
        reconcile: Object.freeze({
          method: 'POST' as const,
          header: 'Idempotency-Key' as const,
          action: 'reconcile' as const,
          fields: Object.freeze(['attemptGlobalId'] as const),
          policy: 'read_only_positive_only' as const,
        }),
      }),
      unsupportedActions: Object.freeze([
        'locationDeactivate',
        'locationDelete',
        'inventoryQuantityWrite',
        'fulfillmentServiceLocationWrite',
      ]),
      providerWrites: 0 as const,
    })
  } catch (error) {
    throw integrationError(error)
  }
}

export async function prepareShopifyLocationAdministration(input: {
  organizationId: unknown
  actorEmail: string
  actorRole: 'owner' | 'admin'
  accountGlobalId: unknown
  action: unknown
  warehouseGlobalId: unknown
  expectedWarehouseRowVersion: unknown
  mappingGlobalId?: unknown
  expectedMappingRowVersion?: unknown
  reason: unknown
  confirmationStatement: unknown
  idempotencyKey: unknown
}) {
  try {
    const requestedAction = action(input.action)
    const accountGlobalId = exactGlobalId(
      input.accountGlobalId,
      /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u,
      'Shopify account',
    )
    const warehouseGlobalId = exactGlobalId(
      input.warehouseGlobalId,
      WAREHOUSE_GLOBAL_ID,
      'ClawPilot warehouse',
    )
    const expectedWarehouseRowVersion = rowVersion(
      input.expectedWarehouseRowVersion,
      'Warehouse version',
    )
    const mappingGlobalId = requestedAction === 'locationAdd'
      ? null
      : exactGlobalId(
          input.mappingGlobalId,
          MAPPING_GLOBAL_ID,
          'Shopify location mapping',
        )
    const expectedMappingRowVersion = requestedAction === 'locationAdd'
      ? null
      : rowVersion(input.expectedMappingRowVersion, 'Location mapping version')
    const authorizationReason = reason(input.reason)
    const localIdempotencyKey = idempotencyKey(input.idempotencyKey)
    const context = await providerContext({
      organizationId: input.organizationId,
      accountGlobalId,
    })
    const configuration =
      await readShopifyLocationAdministrationConfigurationInPostgres({
        organizationId: context.stored.organizationId,
        accountGlobalId,
      })
    const warehouse = configuration.warehouses.find(
      (candidate) => candidate.globalId === warehouseGlobalId,
    )
    if (
      !warehouse
      || warehouse.rowVersion !== expectedWarehouseRowVersion
      || !warehouse.locationAdministrationReady
      || !warehouse.desiredLocation
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_CHANGED',
        'Reload a complete, current ClawPilot warehouse before authorizing Shopify',
        409,
      )
    }
    const desiredLocation = warehouse.desiredLocation
    const locations = await listShopifyLocationAdministrationLocations(
      context.credential,
    )
    const observedAt = new Date().toISOString()
    let mapping: typeof configuration.mappings[number] | null = null
    let providerLocation:
      ShopifyLocationAdministrationProviderLocation | null = null
    if (requestedAction === 'locationAdd') {
      if (
        warehouse.hasActiveCommerceLocationRouting
        || configuration.mappings.some((candidate) => (
          candidate.active && candidate.warehouseGlobalId === warehouseGlobalId
        ))
      ) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_ALREADY_MAPPED',
          'This warehouse already has active commerce location routing',
          409,
        )
      }
      if (locations.some((location) => (
        desiredMatchesLocation(desiredLocation, location)
      ))) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_ALREADY_EXISTS',
          'An exact Shopify merchant location already matches this warehouse; map it instead of creating a duplicate',
          409,
        )
      }
    } else {
      mapping = configuration.mappings.find(
        (candidate) => candidate.globalId === mappingGlobalId,
      ) || null
      if (
        !mapping
        || !mapping.active
        || mapping.warehouseGlobalId !== warehouseGlobalId
        || mapping.rowVersion !== expectedMappingRowVersion
      ) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_MAPPING_CHANGED',
          'Reload the exact Shopify location mapping before authorizing a write',
          409,
        )
      }
      providerLocation = locations.find(
        (candidate) => candidate.id === mapping?.providerLocationId,
      ) || null
      if (!providerLocation) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_NOT_FOUND',
          'The mapped Shopify location no longer exists',
          404,
        )
      }
      assertMerchantManaged(providerLocation)
      if (
        requestedAction === 'locationEdit'
        && desiredMatchesLocation(desiredLocation, providerLocation)
      ) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_NO_CHANGE',
          'The Shopify location already matches this warehouse',
          409,
        )
      }
      if (
        requestedAction === 'locationActivate'
        && providerLocation.isActive
      ) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_ALREADY_ACTIVE',
          'The Shopify location is already active',
          409,
        )
      }
      if (
        requestedAction === 'locationActivate'
        && !providerLocation.activatable
      ) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_NOT_ACTIVATABLE',
          'Shopify reports that this merchant location cannot be activated',
          409,
        )
      }
      if (
        requestedAction === 'locationActivate'
        && !desiredMatchesLocation(desiredLocation, providerLocation)
      ) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_EDIT_REQUIRED',
          'Update this Shopify location to match the mapped ClawPilot warehouse before activating it',
          409,
        )
      }
    }
    const expectedConfirmation = shopifyLocationAdministrationConfirmation({
      action: requestedAction,
      accountGlobalId,
      warehouseGlobalId,
      providerLocationId: providerLocation?.id || null,
    })
    assertConfirmation(input.confirmationStatement, expectedConfirmation)
    const authorization =
      await prepareShopifyLocationAdministrationInPostgres({
        organizationId: context.stored.organizationId,
        actorEmail: input.actorEmail,
        actorRole: input.actorRole,
        accountGlobalId,
        action: requestedAction,
        warehouseGlobalId,
        expectedWarehouseRowVersion,
        mappingGlobalId,
        expectedMappingRowVersion,
        providerLocation,
        providerLocationSetHash: requestedAction === 'locationAdd'
          ? shopifyLocationAdministrationLocationSetHash(locations)
          : null,
        providerObservedAt: observedAt,
        desiredLocation,
        reason: authorizationReason,
        confirmationStatement: expectedConfirmation,
        idempotencyKey: localIdempotencyKey,
      })
    return Object.freeze({
      authorization,
      confirmationStatement: expectedConfirmation,
      providerWrites: 0 as const,
    })
  } catch (error) {
    throw integrationError(error)
  }
}

function authorizationEvidence(
  authorization: ShopifyLocationAdministrationAuthorization,
  result: ShopifyLocationAdministrationProviderResult,
) {
  return {
    schema: 'shopify-location-administration-outcome-v1',
    adapterVersion: SHOPIFY_LOCATION_ADMINISTRATION_ADAPTER_VERSION,
    action: authorization.action,
    authorizationGlobalId: authorization.authorizationGlobalId,
    requestHash: authorization.requestHash,
    providerLocationId: result.location?.id || null,
    providerLocationSnapshot: result.location || null,
    providerLocationSnapshotHash: result.location
      ? locationHash(result.location)
      : null,
    providerMutationAttempted: true,
    providerWritesKnown: result.providerWritesKnown,
    providerWrites: result.providerWrites,
    userErrors: result.userErrors,
    outcome: result.outcome,
    errorCode: result.errorCode,
  }
}

function assertExecutionPrecondition(
  authorization: ShopifyLocationAdministrationAuthorization,
  locations: readonly ShopifyLocationAdministrationProviderLocation[],
) {
  if (authorization.action === 'locationAdd') {
    if (
      shopifyLocationAdministrationLocationSetHash(locations)
        !== authorization.providerLocationSetHash
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_PROVIDER_STATE_CHANGED',
        'Shopify locations changed after authorization; prepare a new request',
        409,
      )
    }
    return
  }
  const location = locations.find(
    (candidate) => candidate.id === authorization.providerLocationId,
  )
  if (!location) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_NOT_FOUND',
      'The authorized Shopify location no longer exists',
      404,
    )
  }
  assertMerchantManaged(location)
  if (locationHash(location) !== authorization.providerSnapshotHash) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_PROVIDER_STATE_CHANGED',
      'The Shopify location changed after authorization; prepare a new request',
      409,
    )
  }
}

export async function executeShopifyLocationAdministration(input: {
  organizationId: unknown
  actorEmail: string
  authorizationGlobalId: unknown
  idempotencyKey: unknown
}) {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const authorizationGlobalId = exactGlobalId(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'Shopify location authorization',
  )
  const localIdempotencyKey = idempotencyKey(input.idempotencyKey)
  let authorization: ShopifyLocationAdministrationAuthorization
  try {
    authorization =
      await readShopifyLocationAdministrationAuthorizationInPostgres({
        organizationId,
        authorizationGlobalId,
      })
    if (authorization.authorizedBy !== input.actorEmail) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_ACTOR_MISMATCH',
        'Only the owner or administrator who prepared this request can execute it',
        403,
      )
    }
    if (authorization.idempotencyKey !== localIdempotencyKey) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_IDEMPOTENCY_CONFLICT',
        'The idempotency key does not match the prepared request',
        409,
      )
    }
    if (
      authorization.status === 'succeeded'
      || authorization.status === 'failed'
      || authorization.status === 'unknown'
      || authorization.status === 'reconciled'
      || authorization.status === 'processing'
    ) {
      const applied = authorization.status === 'succeeded'
        || authorization.status === 'reconciled'
      return Object.freeze({
        authorization,
        replayed: true,
        providerLocationId: authorization.outcomeProviderLocationId,
        mappingRequired: applied
          && authorization.action === 'locationAdd',
        providerWrites: authorization.status === 'succeeded'
          ? 1 as const
          : authorization.status === 'failed'
            ? 0 as const
            : null,
        outcomeUncertain: authorization.status === 'unknown'
          || authorization.status === 'processing',
        reconcileRequired: authorization.status === 'unknown',
        errorCode: authorization.outcomeErrorCode,
        userErrors: Object.freeze([]),
      })
    }
    const context = await providerContext({
      organizationId,
      accountGlobalId: authorization.accountGlobalId,
    })
    if (
      context.stored.credentialVersion !== authorization.credentialGeneration
      || context.shop.id !== authorization.externalAccountId
      || context.shop.domain !== authorization.shopDomain
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RUNTIME_STALE',
        'The Shopify connection changed after authorization',
        409,
      )
    }
    const locations = await listShopifyLocationAdministrationLocations(
      context.credential,
    )
    assertExecutionPrecondition(authorization, locations)
    const claim = await claimShopifyLocationAdministrationInPostgres({
      organizationId,
      actorEmail: input.actorEmail,
      authorizationGlobalId,
      idempotencyKey: localIdempotencyKey,
    })
    const result = await executeShopifyLocationAdministrationProviderMutation({
      credential: context.credential,
      action: claim.action,
      desired: claim.desiredLocation,
      providerLocationId: claim.providerLocationId,
      providerIdempotencyKey: claim.providerIdempotencyKey,
    })
    const outcome = result.outcome === 'succeeded'
      ? 'succeeded' as const
      : result.outcome === 'rejected'
        ? 'failed' as const
        : 'unknown' as const
    const finalized =
      await recordShopifyLocationAdministrationOutcomeInPostgres({
        organizationId,
        actorEmail: input.actorEmail,
        authorizationGlobalId,
        attemptGlobalId: claim.attemptGlobalId,
        outcome,
        providerLocationId: result.location?.id || null,
        providerReference: result.location?.id || null,
        providerWriteCount: result.providerWrites,
        errorCode: result.errorCode,
        evidence: authorizationEvidence(authorization, result),
      })
    return Object.freeze({
      authorization: finalized,
      replayed: false,
      providerLocationId: result.location?.id || null,
      mappingRequired:
        finalized.status === 'succeeded'
        && finalized.action === 'locationAdd',
      providerWrites: result.providerWrites,
      outcomeUncertain: finalized.status === 'unknown',
      reconcileRequired: finalized.status === 'unknown',
      errorCode: result.errorCode,
      userErrors: result.userErrors,
    })
  } catch (error) {
    throw integrationError(error)
  }
}

function confirmedAppliedLocations(
  authorization: ShopifyLocationAdministrationAuthorization,
  locations: readonly ShopifyLocationAdministrationProviderLocation[],
) {
  if (authorization.action === 'locationAdd') {
    return locations.filter((location) => (
      shopifyLocationMatchesDesired(location, authorization.desiredLocation)
    ))
  }
  const location = locations.find(
    (candidate) => candidate.id === authorization.providerLocationId,
  )
  if (!location || location.isFulfillmentService) return []
  if (authorization.action === 'locationActivate') {
    return location.isActive ? [location] : []
  }
  return shopifyLocationMatchesDesired(
    location,
    authorization.desiredLocation,
  ) ? [location] : []
}

export async function reconcileShopifyLocationAdministration(input: {
  organizationId: unknown
  actorEmail: string
  attemptGlobalId: unknown
  idempotencyKey: unknown
}) {
  try {
    const organizationId = normalizeCommerceOrganizationId(input.organizationId)
    const attemptGlobalId = exactGlobalId(
      input.attemptGlobalId,
      ATTEMPT_GLOBAL_ID,
      'Shopify location attempt',
    )
    const localIdempotencyKey = idempotencyKey(input.idempotencyKey)
    let authorization =
      await readShopifyLocationAdministrationAuthorizationInPostgres({
        organizationId,
        attemptGlobalId,
      })
    if (authorization.authorizedBy !== input.actorEmail) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_ACTOR_MISMATCH',
        'Only the owner or administrator who prepared this request can reconcile it',
        403,
      )
    }
    if (authorization.idempotencyKey !== localIdempotencyKey) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_IDEMPOTENCY_CONFLICT',
        'The idempotency key does not match the claimed request',
        409,
      )
    }
    if (authorization.status === 'processing') {
      authorization =
        await recoverStaleShopifyLocationAdministrationInPostgres({
          organizationId,
          actorEmail: input.actorEmail,
          attemptGlobalId,
        })
    }
    if (authorization.status === 'reconciled') {
      return Object.freeze({
        authorization,
        confirmedApplied: true,
        replayed: true,
        providerLocationId: authorization.outcomeProviderLocationId,
        mappingRequired: authorization.action === 'locationAdd',
        providerWrites: null,
      })
    }
    if (authorization.status !== 'unknown') {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RECONCILIATION_NOT_ALLOWED',
        'Only an unknown Shopify location attempt can be reconciled',
        409,
      )
    }
    const context = await providerContext({
      organizationId,
      accountGlobalId: authorization.accountGlobalId,
    })
    if (
      context.stored.credentialVersion !== authorization.credentialGeneration
      || context.shop.id !== authorization.externalAccountId
      || context.shop.domain !== authorization.shopDomain
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RUNTIME_STALE',
        'The Shopify connection changed before reconciliation',
        409,
      )
    }
    const locations = await listShopifyLocationAdministrationLocations(
      context.credential,
    )
    const matches = confirmedAppliedLocations(authorization, locations)
    // Positive-only: absence or ambiguity never becomes proof of no write and
    // never clears the unknown state.
    if (matches.length !== 1) {
      return Object.freeze({
        authorization,
        confirmedApplied: false,
        replayed: false,
        providerLocationId: null,
        mappingRequired: false,
        providerWrites: null,
      })
    }
    const location = matches[0]
    const finalized =
      await reconcileShopifyLocationAdministrationAppliedInPostgres({
        organizationId,
        actorEmail: input.actorEmail,
        authorizationGlobalId: authorization.authorizationGlobalId,
        attemptGlobalId,
        providerLocationId: location.id,
        providerReference: location.id,
        evidence: {
          schema: 'shopify-location-administration-reconciliation-v1',
          adapterVersion: SHOPIFY_LOCATION_ADMINISTRATION_ADAPTER_VERSION,
          action: authorization.action,
          resolution: 'confirmed_applied',
          providerLocation: location,
          providerLocationSnapshotHash: locationHash(location),
          providerWritesKnown: false,
          providerWrites: null,
          providerMutationsDuringReconciliation: 0,
        },
      })
    return Object.freeze({
      authorization: finalized,
      confirmedApplied: true,
      replayed: false,
      providerLocationId: location.id,
      mappingRequired: finalized.action === 'locationAdd',
      providerWrites: null,
    })
  } catch (error) {
    throw integrationError(error)
  }
}

// The persistence layer consumes normalized snapshots, not raw GraphQL
// values. Exporting this helper keeps the exact evidence hash auditable in
// focused provider and database tests.
export function shopifyLocationAdministrationProviderSnapshotHash(
  location: ShopifyLocationAdministrationProviderLocation,
) {
  const hash = locationHash(location)
  if (!SHA256.test(hash)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_INVALID',
      'Shopify location evidence hash was invalid',
      500,
    )
  }
  return hash
}
