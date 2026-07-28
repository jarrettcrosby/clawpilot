import { createHash } from 'node:crypto'
import {
  ShopifyCommerceClientError,
  shopifyAdminGraphql,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  SHOPIFY_INVENTORY_STATE_NAMES,
  shopifyInventoryEquationMatches,
  type ShopifyInventoryQuantities,
  type ShopifyInventoryStateName,
} from '@/lib/operations/shopifyInventoryProjection'

export const SHOPIFY_INVENTORY_ADAPTER_VERSION =
  'shopify-inventory-read-2026-07-v1'

const LOCATION_PAGE_SIZE = 50
const LEVEL_PAGE_SIZE = 25
const MAX_LOCATION_PAGES = 5
const MAX_LEVEL_PAGES = 400
const MAX_DIMENSION_DEFINITION_PAGES = 4
const LOCATION_GID = /^gid:\/\/shopify\/Location\/[1-9][0-9]*$/
const INVENTORY_ITEM_GID =
  /^gid:\/\/shopify\/InventoryItem\/[1-9][0-9]*$/
const INVENTORY_LEVEL_GID =
  /^gid:\/\/shopify\/InventoryLevel\/[^/?#]+(?:\?.*)?$/
const INVENTORY_QUANTITY_GID =
  /^gid:\/\/shopify\/InventoryQuantity\/[^/?#]+(?:\?.*)?$/

export const SHOPIFY_INVENTORY_QUANTITY_NAMES =
  SHOPIFY_INVENTORY_STATE_NAMES

export type ShopifyInventoryAddress = {
  line1: string
  line2: string
  city: string
  region: string
  regionCode: string
  postalCode: string
  country: string
  countryCode: string
}

export type ShopifyInventoryLocation = {
  id: string
  name: string
  isActive: boolean
  shipsInventory: boolean
  fulfillsOnlineOrders: boolean
  hasActiveInventory: boolean
  addressVerified: boolean
  isFulfillmentService: boolean
  fulfillmentService: {
    id: string
    handle: string
    serviceName: string
    type: string
    inventoryManagement: boolean
  } | null
  address: ShopifyInventoryAddress
}

export type ShopifyInventoryLevel = {
  id: string
  locationId: string
  inventoryItemId: string
  sku: string | null
  tracked: boolean
  updatedAt: string | null
  quantities: ShopifyInventoryQuantities
  quantityEvidence: Record<ShopifyInventoryStateName, {
    id: string
    quantity: number
    updatedAt: string | null
  }>
  equationMatches: boolean
  providerWeightGrams: number | null
  providerDimensionsMm: {
    length: number
    width: number
    height: number
    source: 'variant_metafield' | 'product_metafield'
    sourceKeys: string[]
  } | null
  productSnapshot: Record<string, unknown>
  sourceHash: string
}

export type ShopifyInventorySnapshot = {
  fetchedAt: string
  location: ShopifyInventoryLocation
  levels: ShopifyInventoryLevel[]
  pageCount: number
  enrichment: {
    unitCostAvailable: boolean
    productDimensionKeys: Partial<Record<PhysicalAxis, string>>
    variantDimensionKeys: Partial<Record<PhysicalAxis, string>>
    ambiguousDimensionDefinitions: DimensionDefinitionEvidence[]
  }
  snapshotHash: string
}

const LOCATIONS_QUERY = `query ClawPilotInventoryLocations(
  $first: Int!
  $after: String
) {
  locations(
    first: $first
    after: $after
    includeInactive: false
    includeLegacy: true
  ) {
    nodes {
      id
      name
      isActive
      shipsInventory
      fulfillsOnlineOrders
      hasActiveInventory
      addressVerified
      isFulfillmentService
      fulfillmentService {
        id
        handle
        serviceName
        type
        inventoryManagement
      }
      address {
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCode
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

function physicalMetafieldsSelection(input: {
  alias: 'physicalVariantFields' | 'physicalProductFields'
  variable: 'variantDimensionKeys' | 'productDimensionKeys'
  count: number
}) {
  if (!input.count) return ''
  return `${input.alias}: metafields(
    first: ${input.count}
    keys: $${input.variable}
  ) {
    nodes {
      namespace
      key
      type
      value
      jsonValue
      updatedAt
      definition {
        id
        name
        ownerType
        type {
          name
          category
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }`
}

function inventoryLevelsQuery(input: {
  includeUnitCost: boolean
  variantDimensionCount: number
  productDimensionCount: number
}) {
  const dimensionVariables = [
    input.variantDimensionCount
      ? '$variantDimensionKeys: [String!]!'
      : '',
    input.productDimensionCount
      ? '$productDimensionKeys: [String!]!'
      : '',
  ].filter(Boolean).join('\n  ')
  const variantDimensions = physicalMetafieldsSelection({
    alias: 'physicalVariantFields',
    variable: 'variantDimensionKeys',
    count: input.variantDimensionCount,
  })
  const productDimensions = physicalMetafieldsSelection({
    alias: 'physicalProductFields',
    variable: 'productDimensionKeys',
    count: input.productDimensionCount,
  })
  return `query ClawPilotInventoryByLocation(
  $locationId: ID!
  $first: Int!
  $after: String
  $quantityNames: [String!]!
  ${dimensionVariables}
) {
  location(id: $locationId) {
    id
    inventoryLevels(
      first: $first
      after: $after
      includeInactive: false
    ) {
      nodes {
        id
        isActive
        createdAt
        updatedAt
        item {
          id
          legacyResourceId
          sku
          duplicateSkuCount
          tracked
          requiresShipping
          createdAt
          updatedAt
          measurement {
            id
            weight {
              value
              unit
            }
          }
          ${input.includeUnitCost
            ? `unitCost {
            amount
            currencyCode
          }`
            : ''}
          countryCodeOfOrigin
          provinceCodeOfOrigin
          harmonizedSystemCode
          countryHarmonizedSystemCodes(first: 10) {
            nodes {
              countryCode
              harmonizedSystemCode
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          variants(first: 2) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              legacyResourceId
              sku
              barcode
              title
              displayName
              position
              selectedOptions {
                name
                value
              }
              price
              compareAtPrice
              taxable
              inventoryPolicy
              inventoryQuantity
              sellableOnlineQuantity
              availableForSale
              requiresComponents
              createdAt
              updatedAt
              ${variantDimensions}
              product {
                id
                legacyResourceId
                title
                description
                handle
                vendor
                productType
                status
                tags
                isGiftCard
                tracksInventory
                totalInventory
                hasOutOfStockVariants
                hasVariantsThatRequiresComponents
                onlineStoreUrl
                publishedAt
                createdAt
                updatedAt
                category {
                  id
                  name
                  fullName
                }
                options {
                  id
                  name
                  position
                  values
                }
                featuredMedia {
                  id
                  mediaContentType
                  alt
                  preview {
                    image {
                      url
                      altText
                      width
                      height
                    }
                  }
                }
                ${productDimensions}
              }
            }
          }
        }
        quantities(names: $quantityNames) {
          id
          name
          quantity
          updatedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`
}

const DIMENSION_DEFINITIONS_QUERY = `query ClawPilotDimensionDefinitions(
  $ownerType: MetafieldOwnerType!
  $first: Int!
  $after: String
  $definitionQuery: String!
) {
  metafieldDefinitions(
    ownerType: $ownerType
    first: $first
    after: $after
    query: $definitionQuery
  ) {
    nodes {
      id
      namespace
      key
      name
      description
      ownerType
      type {
        name
        category
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string') {
    throw invalidResponse(`Shopify returned an invalid ${label}`)
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized || normalized.length > maximum) {
    throw invalidResponse(`Shopify returned an invalid ${label}`)
  }
  return normalized
}

function optionalText(value: unknown, maximum = 512): string {
  if (value === null || value === undefined || value === '') return ''
  return text(value, 'inventory text', maximum)
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidResponse(`Shopify returned an invalid ${label}`)
  }
  return value
}

function integer(value: unknown, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || Math.abs(value) > 9_007_199_254_740_000
  ) {
    throw invalidResponse(`Shopify returned an invalid ${label}`)
  }
  return value
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw invalidResponse('Shopify returned an invalid inventory timestamp')
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw invalidResponse('Shopify returned an invalid inventory timestamp')
  }
  return parsed.toISOString()
}

function invalidResponse(message: string) {
  return new ShopifyCommerceClientError(
    message,
    502,
    'SHOPIFY_INVENTORY_RESPONSE_INVALID',
  )
}

function connection(value: unknown, label: string) {
  const container = record(value)
  if (!container || !Array.isArray(container.nodes)) {
    throw invalidResponse(`Shopify returned an invalid ${label} connection`)
  }
  const pageInfo = record(container.pageInfo)
  if (
    !pageInfo
    || typeof pageInfo.hasNextPage !== 'boolean'
    || (
      pageInfo.hasNextPage
      && (
        typeof pageInfo.endCursor !== 'string'
        || !pageInfo.endCursor
        || pageInfo.endCursor.length > 4_096
      )
    )
  ) {
    throw invalidResponse(`Shopify returned invalid ${label} pagination`)
  }
  return {
    nodes: container.nodes,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.hasNextPage
      ? pageInfo.endCursor as string
      : null,
  }
}

function inventoryAddress(value: unknown): ShopifyInventoryAddress {
  const address = record(value) || {}
  return {
    line1: optionalText(address.address1, 255),
    line2: optionalText(address.address2, 255),
    city: optionalText(address.city, 255),
    region: optionalText(address.province, 255),
    regionCode: optionalText(address.provinceCode, 64),
    postalCode: optionalText(address.zip, 64),
    country: optionalText(address.country, 255),
    countryCode: optionalText(address.countryCode, 8).toUpperCase(),
  }
}

function inventoryLocation(value: unknown): ShopifyInventoryLocation {
  const location = record(value)
  if (!location) {
    throw invalidResponse('Shopify returned an invalid inventory location')
  }
  const id = text(location.id, 'inventory location ID')
  if (!LOCATION_GID.test(id)) {
    throw invalidResponse('Shopify returned an invalid inventory location ID')
  }
  const fulfillmentServiceValue = record(location.fulfillmentService)
  const fulfillmentService = fulfillmentServiceValue
    ? {
        id: text(
          fulfillmentServiceValue.id,
          'fulfillment service ID',
        ),
        handle: text(
          fulfillmentServiceValue.handle,
          'fulfillment service handle',
          255,
        ),
        serviceName: text(
          fulfillmentServiceValue.serviceName,
          'fulfillment service name',
          255,
        ),
        type: text(
          fulfillmentServiceValue.type,
          'fulfillment service type',
          64,
        ),
        inventoryManagement: boolean(
          fulfillmentServiceValue.inventoryManagement,
          'fulfillment service inventory-management state',
        ),
      }
    : null
  return {
    id,
    name: text(location.name, 'inventory location name', 255),
    isActive: boolean(location.isActive, 'inventory location state'),
    shipsInventory: boolean(
      location.shipsInventory,
      'inventory shipping state',
    ),
    fulfillsOnlineOrders: boolean(
      location.fulfillsOnlineOrders,
      'inventory fulfillment state',
    ),
    hasActiveInventory: boolean(
      location.hasActiveInventory,
      'inventory availability state',
    ),
    addressVerified: boolean(
      location.addressVerified,
      'inventory address-verification state',
    ),
    isFulfillmentService: boolean(
      location.isFulfillmentService,
      'fulfillment-service location state',
    ),
    fulfillmentService,
    address: inventoryAddress(location.address),
  }
}

function quantityStates(value: unknown) {
  if (!Array.isArray(value) || value.length > 32) {
    throw invalidResponse('Shopify returned invalid inventory quantities')
  }
  const states = new Map<
    ShopifyInventoryStateName,
    {
      id: string
      quantity: number
      updatedAt: string | null
    }
  >()
  let latestUpdatedAt: string | null = null
  for (const candidate of value) {
    const quantity = record(candidate)
    if (!quantity) {
      throw invalidResponse('Shopify returned invalid inventory quantities')
    }
    const name = text(
      quantity.name,
      'inventory quantity name',
      64,
    ) as ShopifyInventoryStateName
    if (
      !SHOPIFY_INVENTORY_QUANTITY_NAMES.includes(
        name,
      )
      || states.has(name)
    ) {
      throw invalidResponse('Shopify returned invalid inventory quantities')
    }
    const id = text(quantity.id, 'inventory quantity ID')
    if (!INVENTORY_QUANTITY_GID.test(id)) {
      throw invalidResponse('Shopify returned an invalid inventory quantity ID')
    }
    const updatedAt = timestamp(quantity.updatedAt)
    states.set(name, {
      id,
      quantity: integer(
        quantity.quantity,
        `${name} inventory quantity`,
      ),
      updatedAt,
    })
    if (
      updatedAt
      && (!latestUpdatedAt || updatedAt > latestUpdatedAt)
    ) latestUpdatedAt = updatedAt
  }
  for (const name of SHOPIFY_INVENTORY_QUANTITY_NAMES) {
    if (!states.has(name)) {
      throw invalidResponse(
        `Shopify omitted the ${name} inventory quantity state`,
      )
    }
  }
  return {
    quantities: Object.fromEntries(
      SHOPIFY_INVENTORY_QUANTITY_NAMES.map((name) => [
        name,
        states.get(name)?.quantity as number,
      ]),
    ) as ShopifyInventoryQuantities,
    evidence: Object.fromEntries(
      SHOPIFY_INVENTORY_QUANTITY_NAMES.map((name) => [
        name,
        states.get(name),
      ]),
    ) as ShopifyInventoryLevel['quantityEvidence'],
    updatedAt: latestUpdatedAt,
  }
}

export type PhysicalAxis = 'length' | 'width' | 'height'

export type DimensionDefinitionEvidence = {
  ownerType: 'PRODUCT' | 'PRODUCTVARIANT'
  identifier: string
  type: 'dimension' | 'list.dimension'
  axis: PhysicalAxis | null
  name: string
  description: string
}

type PhysicalDimensionKeys = {
  variant: Partial<Record<PhysicalAxis, string>>
  product: Partial<Record<PhysicalAxis, string>>
  ambiguous: DimensionDefinitionEvidence[]
}

function boundedJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw invalidResponse('Shopify returned invalid product information')
  }
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
    throw invalidResponse('Shopify returned oversized product information')
  }
  const parsed = JSON.parse(serialized)
  if (!record(parsed)) {
    throw invalidResponse('Shopify returned invalid product information')
  }
  return parsed as Record<string, unknown>
}

function dimensionAxis(value: unknown): PhysicalAxis | null {
  const definition = record(value)
  if (!definition) return null
  const descriptor = [
    definition.key,
    definition.name,
    definition.description,
  ]
    .filter((candidate): candidate is string => (
      typeof candidate === 'string'
    ))
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
  const matches: PhysicalAxis[] = []
  if (/\blength\b/.test(descriptor)) matches.push('length')
  if (/\bwidth\b/.test(descriptor)) matches.push('width')
  if (/\bheight\b|\bdepth\b/.test(descriptor)) matches.push('height')
  return matches.length === 1 ? matches[0] : null
}

async function dimensionDefinitions(
  credential: ShopifyCommerceRuntimeCredential,
  ownerType: 'PRODUCT' | 'PRODUCTVARIANT',
  options: ShopifyCommerceClientOptions,
) {
  const candidates = new Map<PhysicalAxis, string[]>()
  const evidence: DimensionDefinitionEvidence[] = []
  for (const definitionQuery of ['type:dimension', 'type:list.dimension']) {
    let after: string | null = null
    for (
      let page = 0;
      page < MAX_DIMENSION_DEFINITION_PAGES;
      page += 1
    ) {
      const data = await shopifyAdminGraphql<{
        metafieldDefinitions?: unknown
      }>(
        credential,
        {
          query: DIMENSION_DEFINITIONS_QUERY,
          operationName: 'ClawPilotDimensionDefinitions',
          variables: {
            ownerType,
            first: 100,
            after,
            definitionQuery,
          },
        },
        options,
      )
      const pageData = connection(
        data.metafieldDefinitions,
        'dimension metafield definitions',
      )
      for (const candidate of pageData.nodes) {
        const definition = record(candidate)
        const type = record(definition?.type)
        if (
          !definition
          || (type?.name !== 'dimension' && type?.name !== 'list.dimension')
        ) continue
        const namespace = text(
          definition.namespace,
          'dimension metafield namespace',
          255,
        )
        const key = text(
          definition.key,
          'dimension metafield key',
          255,
        )
        const identifier = `${namespace}.${key}`
        const axis = dimensionAxis(definition)
        const item: DimensionDefinitionEvidence = {
          ownerType,
          identifier,
          type: type.name,
          axis,
          name: optionalText(definition.name, 255),
          description: optionalText(definition.description, 2_000),
        }
        evidence.push(item)
        if (type.name === 'dimension' && axis) {
          const list = candidates.get(axis) || []
          list.push(identifier)
          candidates.set(axis, list)
        }
      }
      if (!pageData.hasNextPage) break
      after = pageData.endCursor
      if (page === MAX_DIMENSION_DEFINITION_PAGES - 1) {
        throw new ShopifyCommerceClientError(
          'Shopify has more physical-dimension definitions than this bounded sync supports',
          409,
          'SHOPIFY_DIMENSION_DEFINITION_LIMIT_EXCEEDED',
        )
      }
    }
  }
  const result: Partial<Record<PhysicalAxis, string>> = {}
  for (const axis of ['length', 'width', 'height'] as const) {
    const identifiers = candidates.get(axis) || []
    if (identifiers.length === 1) result[axis] = identifiers[0]
  }
  const selected = new Set(Object.values(result))
  return {
    selected: result,
    ambiguous: evidence
      .filter((item) => !selected.has(item.identifier))
      .sort((left, right) => (
        left.ownerType.localeCompare(right.ownerType)
        || left.identifier.localeCompare(right.identifier)
        || left.type.localeCompare(right.type)
      )),
  }
}

async function discoverDimensionKeys(
  credential: ShopifyCommerceRuntimeCredential,
  options: ShopifyCommerceClientOptions,
): Promise<PhysicalDimensionKeys> {
  const [variant, product] = await Promise.all([
    dimensionDefinitions(credential, 'PRODUCTVARIANT', options),
    dimensionDefinitions(credential, 'PRODUCT', options),
  ])
  return {
    variant: variant.selected,
    product: product.selected,
    ambiguous: [...variant.ambiguous, ...product.ambiguous]
      .sort((left, right) => (
        left.ownerType.localeCompare(right.ownerType)
        || left.identifier.localeCompare(right.identifier)
        || left.type.localeCompare(right.type)
      )),
  }
}

function metafieldNodes(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return []
  const parsed = connection(value, 'physical metafields')
  if (parsed.hasNextPage) {
    throw invalidResponse(
      'Shopify returned too many selected physical metafields',
    )
  }
  return parsed.nodes.map((node) => {
    const parsedNode = record(node)
    if (!parsedNode) {
      throw invalidResponse('Shopify returned an invalid physical metafield')
    }
    return parsedNode
  })
}

function dimensionMillimeters(value: unknown): number | null {
  const metafield = record(value)
  if (!metafield || metafield.type !== 'dimension') return null
  let dimension = record(metafield.jsonValue)
  if (!dimension && typeof metafield.value === 'string') {
    try {
      dimension = record(JSON.parse(metafield.value))
    } catch {
      return null
    }
  }
  if (
    !dimension
    || typeof dimension.value !== 'number'
    || !Number.isFinite(dimension.value)
    || dimension.value <= 0
    || typeof dimension.unit !== 'string'
  ) return null
  const multiplier: Record<string, number> = {
    MILLIMETERS: 1,
    MILLIMETER: 1,
    MM: 1,
    CENTIMETERS: 10,
    CENTIMETER: 10,
    CM: 10,
    METERS: 1_000,
    METER: 1_000,
    M: 1_000,
    INCHES: 25.4,
    INCH: 25.4,
    IN: 25.4,
    FEET: 304.8,
    FOOT: 304.8,
    FT: 304.8,
    YARDS: 914.4,
    YARD: 914.4,
    YD: 914.4,
  }
  const factor = multiplier[dimension.unit.trim().toUpperCase()]
  if (!factor) return null
  const millimeters = Math.round(dimension.value * factor)
  return Number.isSafeInteger(millimeters) && millimeters > 0
    ? millimeters
    : null
}

function physicalDimensions(
  fields: Record<string, unknown>[],
  keys: Partial<Record<PhysicalAxis, string>>,
  source: 'variant_metafield' | 'product_metafield',
) {
  const evidence = physicalDimensionEvidence(fields, keys)
  const values = {
    length: evidence.length?.millimeters ?? null,
    width: evidence.width?.millimeters ?? null,
    height: evidence.height?.millimeters ?? null,
  }
  if (
    values.length === null
    || values.width === null
    || values.height === null
  ) return null
  return {
    length: values.length,
    width: values.width,
    height: values.height,
    source,
    sourceKeys: [
      evidence.length?.key as string,
      evidence.width?.key as string,
      evidence.height?.key as string,
    ],
  }
}

function physicalDimensionEvidence(
  fields: Record<string, unknown>[],
  keys: Partial<Record<PhysicalAxis, string>>,
) {
  const byKey = new Map(fields.map((field) => [
    `${String(field.namespace || '')}.${String(field.key || '')}`,
    field,
  ]))
  const evidence: Partial<Record<
    PhysicalAxis,
    { key: string; millimeters: number }
  >> = {}
  for (const axis of ['length', 'width', 'height'] as const) {
    const key = keys[axis]
    if (!key) continue
    const millimeters = dimensionMillimeters(byKey.get(key))
    if (millimeters !== null) evidence[axis] = { key, millimeters }
  }
  return evidence
}

function weightGrams(value: unknown): number | null {
  const measurement = record(value)
  const weight = record(measurement?.weight)
  if (
    !weight
    || typeof weight.value !== 'number'
    || !Number.isFinite(weight.value)
    || weight.value <= 0
    || typeof weight.unit !== 'string'
  ) return null
  const multiplier: Record<string, number> = {
    GRAMS: 1,
    KILOGRAMS: 1_000,
    OUNCES: 28.349523125,
    POUNDS: 453.59237,
  }
  const factor = multiplier[weight.unit.trim().toUpperCase()]
  if (!factor) return null
  const grams = Math.round(weight.value * factor)
  return Number.isSafeInteger(grams) && grams > 0 ? grams : null
}

function inventoryLevel(
  value: unknown,
  locationId: string,
  dimensionKeys: PhysicalDimensionKeys,
): ShopifyInventoryLevel | null {
  const level = record(value)
  if (!level) {
    throw invalidResponse('Shopify returned an invalid inventory level')
  }
  if (level.isActive !== true) return null
  const id = text(level.id, 'inventory level ID')
  if (!INVENTORY_LEVEL_GID.test(id)) {
    throw invalidResponse('Shopify returned an invalid inventory level ID')
  }
  const item = record(level.item)
  if (!item) {
    throw invalidResponse('Shopify returned an invalid inventory item')
  }
  const inventoryItemId = text(item.id, 'inventory item ID')
  if (!INVENTORY_ITEM_GID.test(inventoryItemId)) {
    throw invalidResponse('Shopify returned an invalid inventory item ID')
  }
  const parsedQuantities = quantityStates(level.quantities)
  const quantities = parsedQuantities.quantities
  const updatedCandidates = [
    timestamp(level.updatedAt),
    timestamp(item.updatedAt),
    parsedQuantities.updatedAt,
  ].filter((candidate): candidate is string => Boolean(candidate))
  const updatedAt = updatedCandidates.sort().at(-1) || null
  const variants = connection(item.variants, 'inventory item variants')
  if (variants.nodes.length > 2) {
    throw invalidResponse('Shopify returned invalid inventory item variants')
  }
  const primaryVariant = variants.nodes.length === 1
    ? record(variants.nodes[0])
    : null
  const product = record(primaryVariant?.product)
  const variantFields = primaryVariant
    ? metafieldNodes(primaryVariant.physicalVariantFields)
    : []
  const productFields = product
    ? metafieldNodes(product.physicalProductFields)
    : []
  const dimensions = variants.hasNextPage || variants.nodes.length !== 1
    ? null
    : (
        physicalDimensions(
          variantFields,
          dimensionKeys.variant,
          'variant_metafield',
        )
        || physicalDimensions(
          productFields,
          dimensionKeys.product,
          'product_metafield',
        )
      )
  const dimensionEvidence = {
    variant: physicalDimensionEvidence(
      variantFields,
      dimensionKeys.variant,
    ),
    product: physicalDimensionEvidence(
      productFields,
      dimensionKeys.product,
    ),
  }
  const providerWeightGrams = weightGrams(item.measurement)
  const productSnapshot = boundedJsonObject({
    inventoryItem: {
      id: item.id,
      legacyResourceId: item.legacyResourceId ?? null,
      sku: item.sku ?? null,
      duplicateSkuCount: item.duplicateSkuCount ?? null,
      tracked: item.tracked,
      requiresShipping: item.requiresShipping ?? null,
      measurement: item.measurement ?? null,
      unitCost: item.unitCost ?? null,
      countryCodeOfOrigin: item.countryCodeOfOrigin ?? null,
      provinceCodeOfOrigin: item.provinceCodeOfOrigin ?? null,
      harmonizedSystemCode: item.harmonizedSystemCode ?? null,
      countryHarmonizedSystemCodes:
        item.countryHarmonizedSystemCodes ?? null,
      createdAt: item.createdAt ?? null,
      updatedAt: item.updatedAt ?? null,
    },
    variant: primaryVariant
      ? {
          ...primaryVariant,
          product: product || null,
        }
      : null,
    variantCandidates: variants.nodes,
    variantCountBound: variants.nodes.length,
    variantConnectionHasNextPage: variants.hasNextPage,
    providerWeightGrams,
    providerDimensionsMm: dimensions,
    providerDimensionEvidence: dimensionEvidence,
    dimensionDefinitions: dimensionKeys,
  })
  const normalized = {
    id,
    locationId,
    inventoryItemId,
    sku: item.sku === null || item.sku === undefined || item.sku === ''
      ? null
      : text(item.sku, 'inventory SKU', 255),
    tracked: boolean(item.tracked, 'inventory tracking state'),
    updatedAt,
    quantities,
    quantityEvidence: parsedQuantities.evidence,
    equationMatches: shopifyInventoryEquationMatches(quantities),
    providerWeightGrams,
    providerDimensionsMm: dimensions,
    productSnapshot,
  }
  return {
    ...normalized,
    sourceHash: createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex'),
  }
}

export async function listShopifyInventoryLocations(
  credential: ShopifyCommerceRuntimeCredential,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyInventoryLocation[]> {
  const locations: ShopifyInventoryLocation[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
    const data = await shopifyAdminGraphql<{
      locations?: unknown
    }>(
      credential,
      {
        query: LOCATIONS_QUERY,
        operationName: 'ClawPilotInventoryLocations',
        variables: {
          first: LOCATION_PAGE_SIZE,
          after,
        },
      },
      options,
    )
    const pageData = connection(data.locations, 'inventory locations')
    locations.push(...pageData.nodes.map(inventoryLocation))
    if (!pageData.hasNextPage) {
      return locations.filter((location) => location.isActive)
    }
    after = pageData.endCursor
  }
  throw new ShopifyCommerceClientError(
    'Shopify inventory has more locations than this bounded sync supports',
    409,
    'SHOPIFY_INVENTORY_LOCATION_LIMIT_EXCEEDED',
  )
}

async function retryableInventoryGraphql<T>(
  operation: () => Promise<T>,
) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (
        !(error instanceof ShopifyCommerceClientError)
        || !error.retryable
        || attempt === 2
      ) throw error
      await new Promise((resolve) => {
        setTimeout(resolve, 500 * (2 ** attempt))
      })
    }
  }
  throw lastError
}

export async function fetchShopifyInventorySnapshot(
  credential: ShopifyCommerceRuntimeCredential,
  location: ShopifyInventoryLocation,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyInventorySnapshot> {
  const dimensionKeys = await discoverDimensionKeys(credential, options)
  const variantDimensionKeys = Object.values(dimensionKeys.variant)
  const productDimensionKeys = Object.values(dimensionKeys.product)
  const levels: ShopifyInventoryLevel[] = []
  let after: string | null = null
  let pageCount = 0
  let unitCostAvailable = true
  for (let page = 0; page < MAX_LEVEL_PAGES; page += 1) {
    let data: { location?: unknown }
    try {
      data = await retryableInventoryGraphql(() => (
        shopifyAdminGraphql<{ location?: unknown }>(
          credential,
          {
            query: inventoryLevelsQuery({
              includeUnitCost: unitCostAvailable,
              variantDimensionCount: variantDimensionKeys.length,
              productDimensionCount: productDimensionKeys.length,
            }),
            operationName: 'ClawPilotInventoryByLocation',
            variables: {
              locationId: location.id,
              first: LEVEL_PAGE_SIZE,
              after,
              quantityNames: SHOPIFY_INVENTORY_QUANTITY_NAMES,
              ...(variantDimensionKeys.length
                ? { variantDimensionKeys }
                : {}),
              ...(productDimensionKeys.length
                ? { productDimensionKeys }
                : {}),
            },
          },
          options,
        )
      ))
    } catch (error) {
      if (
        unitCostAvailable
        && error instanceof ShopifyCommerceClientError
        && error.code === 'SHOPIFY_ACCESS_DENIED'
      ) {
        unitCostAvailable = false
        page -= 1
        continue
      }
      throw error
    }
    const returnedLocation = record(data.location)
    if (
      !returnedLocation
      || returnedLocation.id !== location.id
    ) {
      throw invalidResponse('Shopify returned a different inventory location')
    }
    const pageData = connection(
      returnedLocation.inventoryLevels,
      'inventory levels',
    )
    for (const node of pageData.nodes) {
      const parsed = inventoryLevel(node, location.id, dimensionKeys)
      if (parsed) levels.push(parsed)
    }
    pageCount += 1
    if (!pageData.hasNextPage) {
      const fetchedAt = new Date().toISOString()
      const hashPayload = {
        adapterVersion: SHOPIFY_INVENTORY_ADAPTER_VERSION,
        location,
        enrichment: {
          unitCostAvailable,
          productDimensionKeys: dimensionKeys.product,
          variantDimensionKeys: dimensionKeys.variant,
          ambiguousDimensionDefinitions: dimensionKeys.ambiguous,
        },
        levels: [...levels]
          .sort((left, right) => (
            left.inventoryItemId.localeCompare(right.inventoryItemId)
          ))
          .map((level) => ({
            inventoryItemId: level.inventoryItemId,
            sourceHash: level.sourceHash,
          })),
      }
      return {
        fetchedAt,
        location,
        levels,
        pageCount,
        enrichment: hashPayload.enrichment,
        snapshotHash: createHash('sha256')
          .update(JSON.stringify(hashPayload))
          .digest('hex'),
      }
    }
    after = pageData.endCursor
  }
  throw new ShopifyCommerceClientError(
    'Shopify inventory has more levels than this bounded sync supports',
    409,
    'SHOPIFY_INVENTORY_LEVEL_LIMIT_EXCEEDED',
  )
}
