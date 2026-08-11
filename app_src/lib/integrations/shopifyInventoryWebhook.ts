import {
  SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS,
} from '@/lib/integrations/commerceCapabilities'

export type ShopifyInventoryWebhookTargetReason =
  | 'exact_identity'
  | 'unsupported_topic'
  | 'payload_not_object'
  | 'multiple_identity'
  | 'inventory_item_identity_missing'
  | 'inventory_item_identity_malformed'
  | 'inventory_item_identity_oversized'
  | 'inventory_item_identity_conflict'
  | 'location_identity_missing'
  | 'location_identity_malformed'
  | 'location_identity_oversized'
  | 'location_identity_conflict'
  | 'inventory_level_identity_malformed'
  | 'inventory_level_identity_oversized'

export type ShopifyInventoryWebhookTargeting = Readonly<{
  targetingState: 'targeted' | 'full_required'
  reasonCode: ShopifyInventoryWebhookTargetReason
  inventoryItemGid: string | null
  sourceLocationGid: string | null
}>

const INVENTORY_ITEM_TOPIC_SET = new Set<string>([
  'inventory_items/create',
  'inventory_items/delete',
  'inventory_items/update',
])
const INVENTORY_LEVEL_TOPIC_SET = new Set<string>([
  'inventory_levels/connect',
  'inventory_levels/disconnect',
  'inventory_levels/update',
])
const INVENTORY_TOPIC_SET = new Set<string>(
  SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS,
)
const MAX_SHOPIFY_DECIMAL_ID_DIGITS = 20

type IdentityResult =
  | { ok: true; decimalId: string }
  | {
      ok: false
      reason: 'missing' | 'malformed' | 'multiple' | 'oversized'
    }

type GidIdentityResult =
  | { ok: true; decimalId: string | null }
  | {
      ok: false
      reason: 'conflict' | 'malformed' | 'multiple' | 'oversized'
    }

function fullRequired(
  reasonCode: Exclude<ShopifyInventoryWebhookTargetReason, 'exact_identity'>,
): ShopifyInventoryWebhookTargeting {
  return Object.freeze({
    targetingState: 'full_required' as const,
    reasonCode,
    inventoryItemGid: null,
    sourceLocationGid: null,
  })
}

function targeted(
  inventoryItemId: string,
  sourceLocationId: string | null,
): ShopifyInventoryWebhookTargeting {
  return Object.freeze({
    targetingState: 'targeted' as const,
    reasonCode: 'exact_identity',
    inventoryItemGid: `gid://shopify/InventoryItem/${inventoryItemId}`,
    sourceLocationGid: sourceLocationId
      ? `gid://shopify/Location/${sourceLocationId}`
      : null,
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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

function rawTopLevelIdentity(
  verifiedRawPayload: Buffer | string,
  requestedKey: string,
): { present: boolean; multiple: boolean; value: unknown } {
  const source = typeof verifiedRawPayload === 'string'
    ? verifiedRawPayload
    : verifiedRawPayload.toString('utf8')
  let depth = 0
  let present = false
  let exactValue: unknown = null
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      const end = jsonStringEnd(source, index)
      if (end < 0) {
        return { present: true, multiple: false, value: {} }
      }
      if (depth === 1) {
        let decodedKey: unknown = null
        try {
          decodedKey = JSON.parse(source.slice(index, end + 1))
        } catch {
          return { present: true, multiple: false, value: {} }
        }
        let separator = end + 1
        while (/\s/.test(source[separator] || '')) separator += 1
        if (decodedKey === requestedKey && source[separator] === ':') {
          let valueStart = separator + 1
          while (/\s/.test(source[valueStart] || '')) valueStart += 1
          let value: unknown
          if (source[valueStart] === '"') {
            const valueEnd = jsonStringEnd(source, valueStart)
            if (valueEnd < 0) {
              value = {}
            } else {
              try {
                value = JSON.parse(source.slice(valueStart, valueEnd + 1))
              } catch {
                value = {}
              }
            }
          } else if (source[valueStart] === '[') {
            value = []
          } else if (source[valueStart] === '{') {
            value = {}
          } else {
            let valueEnd = valueStart
            while (
              valueEnd < source.length
              && !/[\s,}]/.test(source[valueEnd])
            ) {
              valueEnd += 1
            }
            const token = source.slice(valueStart, valueEnd)
            value = token === 'null' ? null : token
          }
          if (present) {
            return { present: true, multiple: true, value: [] }
          }
          present = true
          exactValue = value
        }
      }
      index = end
      continue
    }
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
  }
  return { present, multiple: false, value: exactValue }
}

function rawTopLevelObjectHasDuplicateKeys(
  verifiedRawPayload: Buffer | string,
) {
  const source = typeof verifiedRawPayload === 'string'
    ? verifiedRawPayload
    : verifiedRawPayload.toString('utf8')
  const keys = new Set<string>()
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      const end = jsonStringEnd(source, index)
      if (end < 0) return true
      if (depth === 1) {
        let separator = end + 1
        while (/\s/.test(source[separator] || '')) separator += 1
        if (source[separator] === ':') {
          let key: unknown
          try {
            key = JSON.parse(source.slice(index, end + 1))
          } catch {
            return true
          }
          if (typeof key !== 'string' || keys.has(key)) return true
          keys.add(key)
        }
      }
      index = end
      continue
    }
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
  }
  return false
}

function exactRequiredIdentityValue(
  verifiedRawPayload: Buffer | string,
  payload: Record<string, unknown>,
  key: string,
) {
  const exact = rawTopLevelIdentity(verifiedRawPayload, key)
  if (exact.multiple) return []
  return exact.present ? exact.value : payload[key]
}

function decimalIdentity(value: unknown): IdentityResult {
  if (value === undefined || value === null || value === '') {
    return { ok: false, reason: 'missing' }
  }
  if (Array.isArray(value)) return { ok: false, reason: 'multiple' }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      return { ok: false, reason: 'malformed' }
    }
    if (!Number.isSafeInteger(value)) {
      return { ok: false, reason: 'oversized' }
    }
    return { ok: true, decimalId: String(value) }
  }
  if (typeof value !== 'string' || value !== value.trim()) {
    return { ok: false, reason: 'malformed' }
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    return { ok: false, reason: 'malformed' }
  }
  if (value.length > MAX_SHOPIFY_DECIMAL_ID_DIGITS) {
    return { ok: false, reason: 'oversized' }
  }
  return { ok: true, decimalId: value }
}

function reconcilePrimaryIdentity(
  value: unknown,
  exactGidDecimalId: string | null,
): IdentityResult | { ok: false; reason: 'conflict' } {
  const primary = decimalIdentity(value)
  if (primary.ok) {
    if (
      exactGidDecimalId
      && primary.decimalId !== exactGidDecimalId
    ) {
      return { ok: false, reason: 'conflict' }
    }
    return primary
  }
  // Shopify's REST webhook JSON examples contain resource IDs beyond the
  // JavaScript safe-integer range. JSON.parse has already rounded that number,
  // so it cannot be a target by itself. A signed exact Shopify GID can recover
  // the decimal identity only when converting that GID produces the same
  // rounded numeric value. Without the GID, the event remains full_required.
  if (
    primary.reason === 'oversized'
    && typeof value === 'number'
    && exactGidDecimalId
    && Number(exactGidDecimalId) === value
  ) {
    return { ok: true, decimalId: exactGidDecimalId }
  }
  return primary
}

function mergeExactIdentity(
  first: string | null,
  second: string | null,
): { ok: true; decimalId: string | null } | { ok: false } {
  if (first && second && first !== second) return { ok: false }
  return { ok: true, decimalId: first || second }
}

function gidIdentity(
  values: unknown[],
  resource: 'InventoryItem' | 'Location',
): GidIdentityResult {
  const present = values.filter(
    (value) => value !== undefined && value !== null && value !== '',
  )
  if (!present.length) return { ok: true, decimalId: null }
  if (present.some(Array.isArray)) {
    return { ok: false, reason: 'multiple' }
  }
  const decimalIds = new Set<string>()
  for (const value of present) {
    if (typeof value !== 'string' || value !== value.trim()) {
      return { ok: false, reason: 'malformed' }
    }
    const prefix = `gid://shopify/${resource}/`
    if (!value.startsWith(prefix)) {
      return { ok: false, reason: 'malformed' }
    }
    const decimal = value.slice(prefix.length)
    if (!/^[1-9][0-9]*$/.test(decimal)) {
      return { ok: false, reason: 'malformed' }
    }
    if (decimal.length > MAX_SHOPIFY_DECIMAL_ID_DIGITS) {
      return { ok: false, reason: 'oversized' }
    }
    decimalIds.add(decimal)
  }
  if (decimalIds.size !== 1) {
    return { ok: false, reason: 'conflict' }
  }
  return { ok: true, decimalId: [...decimalIds][0] }
}

function inventoryLevelGidIdentity(values: unknown[]):
  | { ok: true; inventoryItemId: string | null }
  | {
      ok: false
      reason: 'malformed' | 'multiple' | 'oversized'
    } {
  const present = values.filter(
    (value) => value !== undefined && value !== null && value !== '',
  )
  if (!present.length) {
    return { ok: true, inventoryItemId: null }
  }
  if (present.some(Array.isArray)) {
    return { ok: false, reason: 'multiple' }
  }
  const identities = new Map<string, {
    inventoryItemId: string
  }>()
  for (const value of present) {
    if (typeof value !== 'string' || value !== value.trim()) {
      return { ok: false, reason: 'malformed' }
    }
    const match = value.match(
      /^gid:\/\/shopify\/InventoryLevel\/([1-9][0-9]*)\?inventory_item_id=([1-9][0-9]*)$/,
    )
    if (!match) return { ok: false, reason: 'malformed' }
    if (
      match[1].length > MAX_SHOPIFY_DECIMAL_ID_DIGITS
      || match[2].length > MAX_SHOPIFY_DECIMAL_ID_DIGITS
    ) {
      return { ok: false, reason: 'oversized' }
    }
    // The path segment is the InventoryLevel child identity. It is not a
    // Location GID and must never be compared with the payload location_id.
    identities.set(`${match[1]}\0${match[2]}`, {
      inventoryItemId: match[2],
    })
  }
  if (identities.size !== 1) return { ok: false, reason: 'multiple' }
  const exact = [...identities.values()][0]
  return {
    ok: true,
    inventoryItemId: exact.inventoryItemId,
  }
}

function identityReasonCode(
  subject: 'inventory_item' | 'location',
  reason: 'conflict' | 'missing' | 'malformed' | 'multiple' | 'oversized',
): Exclude<ShopifyInventoryWebhookTargetReason, 'exact_identity'> {
  if (reason === 'multiple') return 'multiple_identity'
  return `${subject}_identity_${reason}` as Exclude<
    ShopifyInventoryWebhookTargetReason,
    'exact_identity'
  >
}

function hasPluralIdentity(payload: Record<string, unknown>) {
  return [
    'ids',
    'inventory_item_ids',
    'inventory_items',
    'location_ids',
    'locations',
  ].some((key) => Object.prototype.hasOwnProperty.call(payload, key))
}

/**
 * Projects one bounded identity only from a Shopify payload whose raw-body
 * HMAC has already been verified. Quantities and all other provider values are
 * deliberately ignored. An unsafe projection keeps the signed receipt valid
 * and asks the existing complete authoritative read to remain the only
 * reconciliation path.
 */
export function shopifyInventoryWebhookTargeting(input: {
  topic: string
  verifiedPayload: unknown
  verifiedRawPayload: Buffer | string
}): ShopifyInventoryWebhookTargeting {
  if (!INVENTORY_TOPIC_SET.has(input.topic)) {
    return fullRequired('unsupported_topic')
  }
  if (Array.isArray(input.verifiedPayload)) {
    return fullRequired('multiple_identity')
  }
  const payload = record(input.verifiedPayload)
  if (!payload) return fullRequired('payload_not_object')
  if (rawTopLevelObjectHasDuplicateKeys(input.verifiedRawPayload)) {
    return fullRequired('multiple_identity')
  }
  if (hasPluralIdentity(payload)) {
    return fullRequired('multiple_identity')
  }

  if (INVENTORY_ITEM_TOPIC_SET.has(input.topic)) {
    const itemGid = gidIdentity([
      payload.admin_graphql_api_id,
      payload.inventory_item_admin_graphql_api_id,
      payload.inventory_item_gid,
    ], 'InventoryItem')
    if (!itemGid.ok) {
      return fullRequired(identityReasonCode(
        'inventory_item',
        itemGid.reason,
      ))
    }
    const inventoryItem = reconcilePrimaryIdentity(
      exactRequiredIdentityValue(input.verifiedRawPayload, payload, 'id'),
      itemGid.decimalId,
    )
    if (!inventoryItem.ok) {
      return fullRequired(identityReasonCode(
        'inventory_item',
        inventoryItem.reason,
      ))
    }
    return targeted(inventoryItem.decimalId, null)
  }

  if (!INVENTORY_LEVEL_TOPIC_SET.has(input.topic)) {
    return fullRequired('unsupported_topic')
  }
  const itemGid = gidIdentity([
    payload.inventory_item_admin_graphql_api_id,
    payload.inventory_item_gid,
  ], 'InventoryItem')
  if (!itemGid.ok) {
    return fullRequired(identityReasonCode(
      'inventory_item',
      itemGid.reason,
    ))
  }
  const locationGid = gidIdentity([
    payload.location_admin_graphql_api_id,
    payload.location_gid,
  ], 'Location')
  if (!locationGid.ok) {
    return fullRequired(identityReasonCode('location', locationGid.reason))
  }
  const inventoryLevelGid = inventoryLevelGidIdentity([
    payload.admin_graphql_api_id,
    payload.inventory_level_gid,
  ])
  if (!inventoryLevelGid.ok) {
    if (inventoryLevelGid.reason === 'multiple') {
      return fullRequired('multiple_identity')
    }
    return fullRequired(
      `inventory_level_identity_${inventoryLevelGid.reason}`,
    )
  }
  const exactItemIdentity = mergeExactIdentity(
    itemGid.decimalId,
    inventoryLevelGid.inventoryItemId,
  )
  if (!exactItemIdentity.ok) {
    return fullRequired('inventory_item_identity_conflict')
  }
  const inventoryItem = reconcilePrimaryIdentity(
    exactRequiredIdentityValue(
      input.verifiedRawPayload,
      payload,
      'inventory_item_id',
    ),
    exactItemIdentity.decimalId,
  )
  if (!inventoryItem.ok) {
    return fullRequired(identityReasonCode(
      'inventory_item',
      inventoryItem.reason,
    ))
  }
  const location = reconcilePrimaryIdentity(
    exactRequiredIdentityValue(
      input.verifiedRawPayload,
      payload,
      'location_id',
    ),
    locationGid.decimalId,
  )
  if (!location.ok) {
    return fullRequired(identityReasonCode('location', location.reason))
  }
  return targeted(inventoryItem.decimalId, location.decimalId)
}
