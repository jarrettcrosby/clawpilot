import { emailBodyPreview } from '@/lib/crm/emailBodyPreview.mjs'

import {
  SHOPIFY_NATIVE_ACTIVITY_PAGE_SIZE,
  SHOPIFY_NATIVE_ACTIVITY_MAX_PAGES,
} from '@/lib/integrations/commerceOrderHistoryReadLimits'

type JsonRecord = Record<string, unknown>
export type ShopifyNativeActivityEvent = {
  externalEventId: string
  externalSubjectId: string
  eventKind: 'provider_activity'
  eventStatus: string
  providerMessage: string | null
  providerActorDisplayName: string | null
  attributionSource: 'provider_system' | 'unavailable'
  inventoryEffectKind: 'none'
  occurredAt: string
}
export type ShopifyNativeActivity = {
  events: ShopifyNativeActivityEvent[]
  nativeActivityState: 'complete' | 'partial' | 'unavailable'
  nativeActivityReason: string | null
  nativeActivityFetchedCount: number
  providerReads: number
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null
}

/** Provider HTML is converted to text, never mounted. Even otherwise safe
 * links are deliberately not interactive in this audit-evidence projection. */
export function shopifyNativeActivityText(value: string, formatted = true) {
  return emailBodyPreview(formatted ? `<div>${value}</div>` : value)
    .map((part: { text: string }) => part.text).join('')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
}

export function shopifyOrderNativeActivityQuery(includeStaffAuthors: boolean) {
  return `query ClawPilotShopifyOrderNativeActivity($id: ID!, $after: String, $query: String!) {
  order(id: $id) {
    id
    events(first: ${SHOPIFY_NATIVE_ACTIVITY_PAGE_SIZE}, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        __typename id action createdAt message appTitle attributeToUser attributeToApp
        ... on BasicEvent { actor: author secondaryMessage subjectId }
        ... on CommentEvent { rawMessage edited ${includeStaffAuthors ? 'staffAuthor: author { id name }' : ''} }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`
}

function nativeEvent(value: unknown, orderId: string, observedAt: string) {
  const node = record(value)
  if (!node || !['BasicEvent', 'CommentEvent'].includes(String(node.__typename))
    || typeof node.id !== 'string'
    || !/^gid:\/\/shopify\/(?:BasicEvent|CommentEvent)\/[1-9][0-9]*$/u.test(node.id)
    || !node.id.startsWith(`gid://shopify/${node.__typename}/`)
    || typeof node.action !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(node.action)
    || typeof node.createdAt !== 'string' || !Number.isFinite(Date.parse(node.createdAt))
    || Date.parse(node.createdAt) > Date.parse(observedAt)
    || typeof node.message !== 'string'
    || typeof node.attributeToUser !== 'boolean' || typeof node.attributeToApp !== 'boolean'
    || (node.__typename === 'BasicEvent' && node.subjectId !== orderId)) {
    return null
  }
  const comment = node.__typename === 'CommentEvent'
  if (comment && typeof node.rawMessage !== 'string') return null
  const body = comment ? node.rawMessage as string : node.message
  const secondary = !comment && typeof node.secondaryMessage === 'string'
    ? node.secondaryMessage : ''
  // Bound parsing even if a provider sends an unexpectedly large note.
  let limited = body.length > 32_000 || secondary.length > 32_000
  const message = [shopifyNativeActivityText(body.slice(0, 32_000), !comment),
    secondary ? shopifyNativeActivityText(secondary.slice(0, 32_000)) : '']
    .filter(Boolean).join('\n')
  const actor = comment ? record(node.staffAuthor)?.name : node.actor
  if (actor !== undefined && actor !== null && typeof actor !== 'string') return null
  // Display labels are single-line text. Provider controls must not reach the
  // persistence text guard and turn an optional activity row into a core error.
  const actorDisplay = typeof actor === 'string'
    ? actor.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim() : ''
  limited ||= message.length > 8_000 || (typeof actor === 'string' && actor.length > 255)
  return {
    limited,
    event: {
      externalEventId: node.id,
      externalSubjectId: orderId,
      eventKind: 'provider_activity' as const,
      eventStatus: node.action,
      providerMessage: message.slice(0, 8_000) || null,
      providerActorDisplayName: actorDisplay ? actorDisplay.slice(0, 255) : null,
      // A provider display label is not a staff identity or a local actor email.
      attributionSource: node.attributeToUser ? 'unavailable' as const
        : node.attributeToApp ? 'provider_system' as const : 'unavailable' as const,
      inventoryEffectKind: 'none' as const,
      occurredAt: new Date(node.createdAt).toISOString(),
    },
  }
}

/** Optional, read-only native activity. Every attempted page counts, including
 * failures. A page/field/access failure never discards a valid core order. */
export async function readShopifyOrderNativeActivity(input: {
  externalOrderId: string
  observedAt: string
  includeStaffAuthors: boolean
  readPage: (request: {
    query: string
    operationName: string
    variables: Record<string, unknown>
  }) => Promise<unknown>
}): Promise<ShopifyNativeActivity> {
  const result: ShopifyNativeActivity = {
    events: [], nativeActivityState: 'unavailable', nativeActivityReason: null,
    nativeActivityFetchedCount: 0, providerReads: 0,
  }
  const seen = new Set<string>()
  let cursor: string | null = null
  let partialReason: string | null = null
  for (let page = 0; page < SHOPIFY_NATIVE_ACTIVITY_MAX_PAGES; page += 1) {
    let data: unknown
    result.providerReads += 1
    try {
      data = await input.readPage({
        query: shopifyOrderNativeActivityQuery(input.includeStaffAuthors),
        operationName: 'ClawPilotShopifyOrderNativeActivity',
        variables: { id: input.externalOrderId, after: cursor,
          query: `comments:true created_at:<=${input.observedAt}` },
      })
    } catch {
      result.nativeActivityState = result.nativeActivityFetchedCount ? 'partial' : 'unavailable'
      result.nativeActivityReason = 'provider_unavailable'
      return result
    }
    const order = record(record(data)?.order)
    const connection = record(order?.events)
    const info = record(connection?.pageInfo)
    if (order?.id !== input.externalOrderId || !Array.isArray(connection?.nodes)
      || connection.nodes.length > SHOPIFY_NATIVE_ACTIVITY_PAGE_SIZE
      || typeof info?.hasNextPage !== 'boolean') {
      result.nativeActivityState = result.nativeActivityFetchedCount ? 'partial' : 'unavailable'
      result.nativeActivityReason = 'invalid_provider_page'
      return result
    }
    for (const value of connection.nodes) {
      result.nativeActivityFetchedCount += 1
      const normalized = nativeEvent(value, input.externalOrderId, input.observedAt)
      if (!normalized) { partialReason ||= 'invalid_provider_event'; continue }
      if (seen.has(normalized.event.externalEventId)) {
        partialReason ||= 'duplicate_provider_event'
        continue
      }
      seen.add(normalized.event.externalEventId)
      if (normalized.limited) partialReason ||= 'text_limit'
      result.events.push(normalized.event)
    }
    if (!info.hasNextPage) {
      result.nativeActivityState = partialReason ? 'partial' : 'complete'
      result.nativeActivityReason = partialReason
      return result
    }
    const next = info.endCursor
    if (typeof next !== 'string' || !next.trim() || next.length > 4_096 || next === cursor) {
      result.nativeActivityState = 'partial'
      result.nativeActivityReason = 'invalid_provider_cursor'
      return result
    }
    cursor = next
  }
  result.nativeActivityState = 'partial'
  result.nativeActivityReason = partialReason || 'page_budget'
  return result
}
