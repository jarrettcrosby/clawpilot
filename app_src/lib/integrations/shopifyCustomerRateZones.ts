const CUSTOMER_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const CUSTOMER_GID_PATTERN = /^gid:\/\/shopify\/Customer\/[1-9][0-9]{0,19}$/
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/
const PROVINCE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,15}$/
const MAX_POSTAL_CODE_LENGTH = 32
const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_ADDRESSES = 250

export type ShopifyCustomerRateZone = {
  countryCode: string
  provinceCode: string | null
  postalCode: string
}

export type ShopifyCustomerRateZoneResult = {
  zones: ShopifyCustomerRateZone[]
  counts: {
    scanned: number
    eligible: number
    duplicate: number
    skipped: number
  }
}

type ShopifyCustomerAddressGraphql = <T>(
  credential: {
    shopDomain: string
    accessToken: string
  },
  request: {
    query: string
    variables: Record<string, unknown>
    operationName: string
  },
) => Promise<T>

export class ShopifyCustomerRateZoneError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'ShopifyCustomerRateZoneError'
    this.code = code
    this.status = status
  }
}

const CUSTOMER_ADDRESSES_QUERY = `query ClawPilotCustomerRateZones(
  $customerId: ID!
  $first: Int!
  $after: String
) {
  customer(id: $customerId) {
    id
    addressesV2(first: $first, after: $after) {
      nodes {
        countryCodeV2
        provinceCode
        zip
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedPostalCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const postalCode = value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
  return (
    postalCode.length >= 1
    && postalCode.length <= MAX_POSTAL_CODE_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(postalCode)
  )
    ? postalCode
    : null
}

function normalizedCountryCode(value: unknown): string | null {
  const countryCode = typeof value === 'string'
    ? value.trim().toUpperCase()
    : ''
  return COUNTRY_CODE_PATTERN.test(countryCode) ? countryCode : null
}

function normalizedProvinceCode(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null
  const provinceCode = typeof value === 'string'
    ? value.normalize('NFKC').trim().toUpperCase()
    : ''
  return PROVINCE_CODE_PATTERN.test(provinceCode)
    ? provinceCode
    : undefined
}

function normalizedZone(value: unknown): ShopifyCustomerRateZone | null {
  const address = record(value)
  if (!address) return null
  const countryCode = normalizedCountryCode(address.countryCodeV2)
  const provinceCode = normalizedProvinceCode(address.provinceCode)
  const postalCode = normalizedPostalCode(address.zip)
  if (!countryCode || provinceCode === undefined || !postalCode) return null
  return { countryCode, provinceCode, postalCode }
}

function hasCustomerReadScope(scopes: readonly string[]) {
  return scopes.includes('read_customers') || scopes.includes('write_customers')
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const candidate = value ?? fallback
  if (
    !Number.isSafeInteger(candidate)
    || candidate < minimum
    || candidate > maximum
  ) {
    throw new ShopifyCustomerRateZoneError(
      'SHOPIFY_CUSTOMER_RATE_ZONE_BOUNDS_INVALID',
      'Shopify customer address bounds were invalid',
      500,
    )
  }
  return candidate
}

export async function readShopifyCustomerRateZones(input: {
  customerId: string
  credential: {
    shopDomain: string
    accessToken: string
  }
  grantedScopes: readonly string[]
  graphql: ShopifyCustomerAddressGraphql
  pageSize?: number
  maxAddresses?: number
}): Promise<ShopifyCustomerRateZoneResult> {
  if (!CUSTOMER_ID_PATTERN.test(input.customerId)) {
    throw new ShopifyCustomerRateZoneError(
      'SHOPIFY_CUSTOMER_ID_INVALID',
      'Shopify customer identity was invalid',
      400,
    )
  }
  if (!hasCustomerReadScope(input.grantedScopes)) {
    throw new ShopifyCustomerRateZoneError(
      'SHOPIFY_READ_CUSTOMERS_SCOPE_REQUIRED',
      'Shopify read_customers scope is required for saved rate zones',
      409,
    )
  }

  const pageSize = boundedInteger(
    input.pageSize,
    DEFAULT_PAGE_SIZE,
    1,
    250,
  )
  const maxAddresses = boundedInteger(
    input.maxAddresses,
    DEFAULT_MAX_ADDRESSES,
    1,
    250,
  )
  const customerGid = `gid://shopify/Customer/${input.customerId}`
  const zonesByKey = new Map<string, ShopifyCustomerRateZone>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let scanned = 0
  let duplicate = 0
  let skipped = 0

  while (true) {
    const data = await input.graphql<{
      customer?: unknown
    }>(
      input.credential,
      {
        query: CUSTOMER_ADDRESSES_QUERY,
        variables: {
          customerId: customerGid,
          first: Math.min(pageSize, maxAddresses - scanned),
          after: cursor,
        },
        operationName: 'ClawPilotCustomerRateZones',
      },
    )
    const customer = record(data.customer)
    if (
      !customer
      || typeof customer.id !== 'string'
      || !CUSTOMER_GID_PATTERN.test(customer.id)
      || customer.id !== customerGid
    ) {
      throw new ShopifyCustomerRateZoneError(
        'SHOPIFY_CUSTOMER_NOT_FOUND',
        'Shopify customer could not be resolved for this store',
        404,
      )
    }
    const connection = record(customer.addressesV2)
    const nodes = connection?.nodes
    const pageInfo = record(connection?.pageInfo)
    if (
      !connection
      || !Array.isArray(nodes)
      || !pageInfo
      || typeof pageInfo.hasNextPage !== 'boolean'
    ) {
      throw new ShopifyCustomerRateZoneError(
        'SHOPIFY_CUSTOMER_ADDRESSES_INVALID',
        'Shopify returned invalid customer address data',
      )
    }
    if (scanned + nodes.length > maxAddresses) {
      throw new ShopifyCustomerRateZoneError(
        'SHOPIFY_CUSTOMER_ADDRESSES_LIMIT_EXCEEDED',
        'Shopify customer address data exceeded the supported bound',
      )
    }
    for (const node of nodes) {
      scanned += 1
      const zone = normalizedZone(node)
      if (!zone) {
        skipped += 1
        continue
      }
      const key = [
        zone.countryCode,
        zone.postalCode,
      ].join('\u001f')
      const existing = zonesByKey.get(key)
      if (existing) {
        duplicate += 1
        const provinceCode = [
          existing.provinceCode,
          zone.provinceCode,
        ]
          .filter((value): value is string => Boolean(value))
          .sort((left, right) => left.localeCompare(right))[0] || null
        zonesByKey.set(key, {
          countryCode: zone.countryCode,
          provinceCode,
          postalCode: zone.postalCode,
        })
        continue
      }
      zonesByKey.set(key, zone)
    }
    if (!pageInfo.hasNextPage) break
    if (scanned >= maxAddresses) {
      throw new ShopifyCustomerRateZoneError(
        'SHOPIFY_CUSTOMER_ADDRESSES_LIMIT_EXCEEDED',
        'Shopify customer address data exceeded the supported bound',
      )
    }
    const nextCursor = pageInfo.endCursor
    if (
      typeof nextCursor !== 'string'
      || !nextCursor
      || nextCursor.length > 2_048
      || seenCursors.has(nextCursor)
    ) {
      throw new ShopifyCustomerRateZoneError(
        'SHOPIFY_CUSTOMER_ADDRESSES_CURSOR_INVALID',
        'Shopify returned invalid customer address pagination',
      )
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  const zones = [...zonesByKey.values()].sort((left, right) => (
    left.countryCode.localeCompare(right.countryCode)
    || left.postalCode.localeCompare(right.postalCode)
    || String(left.provinceCode || '').localeCompare(
      String(right.provinceCode || ''),
    )
  ))
  return {
    zones,
    counts: {
      scanned,
      eligible: zones.length,
      duplicate,
      skipped,
    },
  }
}
