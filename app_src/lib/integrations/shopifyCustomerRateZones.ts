const CUSTOMER_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const CUSTOMER_GID_PATTERN = /^gid:\/\/shopify\/Customer\/[1-9][0-9]{0,19}$/
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/
const PROVINCE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,15}$/
const MAX_POSTAL_CODE_LENGTH = 32
const MAX_ADDRESS_LINE_LENGTH = 255
const MAX_CITY_LENGTH = 255
const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_ADDRESSES = 250

export type ShopifyCustomerRateDestination = {
  address1: string
  address2: string
  city: string
  province: string
  country: string
  zip: string
}

export type ShopifyCustomerRateDestinationResult = {
  destinations: ShopifyCustomerRateDestination[]
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

const CUSTOMER_ADDRESSES_QUERY = `query ClawPilotCustomerRateDestinations(
  $customerId: ID!
  $first: Int!
  $after: String
) {
  customer(id: $customerId) {
    id
    addressesV2(first: $first, after: $after) {
      nodes {
        address1
        address2
        city
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

function storedPostalCode(value: unknown): string | null {
  const postalCode = typeof value === 'string' ? value : ''
  return (
    postalCode.trim().length >= 1
    && postalCode.length <= MAX_POSTAL_CODE_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(postalCode)
  )
    ? postalCode
    : null
}

function storedCountryCode(value: unknown): string | null {
  const countryCode = typeof value === 'string' ? value : ''
  return COUNTRY_CODE_PATTERN.test(countryCode) ? countryCode : null
}

function storedProvinceCode(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null
  const provinceCode = typeof value === 'string' ? value : ''
  return PROVINCE_CODE_PATTERN.test(provinceCode)
    ? provinceCode
    : undefined
}

function storedRequiredText(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== 'string') return null
  return (
    value.trim().length >= 1
    && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f]/.test(value)
  )
    ? value
    : null
}

function storedOptionalText(
  value: unknown,
  maximumLength: number,
): string | null {
  if (value === null || value === undefined || value === '') return ''
  return storedRequiredText(value, maximumLength)
}

function canonicalDestinationPart(value: string) {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleUpperCase('en-US')
}

function storedDestination(
  value: unknown,
): ShopifyCustomerRateDestination | null {
  const address = record(value)
  if (!address) return null
  const address1 = storedRequiredText(
    address.address1,
    MAX_ADDRESS_LINE_LENGTH,
  )
  const address2 = storedOptionalText(
    address.address2,
    MAX_ADDRESS_LINE_LENGTH,
  )
  const city = storedRequiredText(address.city, MAX_CITY_LENGTH)
  const province = storedProvinceCode(address.provinceCode)
  const country = storedCountryCode(address.countryCodeV2)
  const zip = storedPostalCode(address.zip)
  if (
    !address1
    || address2 === null
    || !city
    || province === undefined
    || !country
    || !zip
  ) return null
  return {
    address1,
    address2,
    city,
    province: province || '',
    country,
    zip,
  }
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

export async function readShopifyCustomerRateDestinations(input: {
  customerId: string
  credential: {
    shopDomain: string
    accessToken: string
  }
  grantedScopes: readonly string[]
  graphql: ShopifyCustomerAddressGraphql
  pageSize?: number
  maxAddresses?: number
}): Promise<ShopifyCustomerRateDestinationResult> {
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
      'Shopify read_customers scope is required for saved destinations',
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
  const destinationsByKey = new Map<
    string,
    ShopifyCustomerRateDestination
  >()
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
        operationName: 'ClawPilotCustomerRateDestinations',
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
      const destination = storedDestination(node)
      if (!destination) {
        skipped += 1
        continue
      }
      const key = [
        destination.address1,
        destination.address2,
        destination.city,
        destination.province,
        destination.country,
        destination.zip,
      ]
        .map(canonicalDestinationPart)
        .join('\u001f')
      if (destinationsByKey.has(key)) {
        duplicate += 1
        continue
      }
      destinationsByKey.set(key, destination)
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

  const destinations = [...destinationsByKey.values()].sort((left, right) => (
    left.country.localeCompare(right.country)
    || left.zip.localeCompare(right.zip)
    || left.province.localeCompare(right.province)
    || left.city.localeCompare(right.city)
    || left.address1.localeCompare(right.address1)
    || left.address2.localeCompare(right.address2)
  ))
  return {
    destinations,
    counts: {
      scanned,
      eligible: destinations.length,
      duplicate,
      skipped,
    },
  }
}
