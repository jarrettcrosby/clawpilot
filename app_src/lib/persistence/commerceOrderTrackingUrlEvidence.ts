import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'

type Scope = {
  organizationId: string
  integrationAccountId: string
  provider: 'shopify' | 'faire'
}
type Event = {
  eventHash: string
  eventKind: string
  trackingNumber: string | null
  trackingUrl: string | null
  providerActorFingerprint: string | null
}
type Observation = {
  externalOrderId: string
  sourceHash: string
  providerUpdatedAt: string | null
  observedAt: string
  events: readonly Event[]
}
type RetainedEvent = {
  id: string
  event_hash: string
  event_kind: string
  tracking_number: string | null
  tracking_url: string | null
  provider_actor_fingerprint: string | null
  sensitive_evidence_expires_at: Date
  sensitive_evidence_redacted_at: Date | null
  expired: boolean
  base_source_hash: string
  base_provider_updated_at: Date | null
  latest_id: string | null
  latest_url: string | null
  latest_provider_updated_at: Date | null
  matched_id: string | null
  matched_url: string | null
}
export type CommerceOrderTrackingUrlEnrichment = {
  baseEventId: string
  trackingUrl: string
  trackingNumber: string | null
  providerActorFingerprint: string | null
  expiresAt: Date
}

/** Inspect under the caller's existing per-order advisory lock. Sensitive
 * values never become durable identifiers; only an explicit provider clock
 * may authorize replacing a previously observed URL. */
export async function inspectCommerceOrderTrackingUrlEvidenceWithClient(
  client: PoolClient,
  scope: Scope,
  observation: Observation,
  options: { requireRetained: boolean; conflict: () => never },
): Promise<CommerceOrderTrackingUrlEnrichment[]> {
  const events = observation.events.filter((event) => (
    event.eventKind !== 'provider_activity' && (event.eventKind === 'tracking_updated' || event.trackingNumber !== null
      || event.trackingUrl !== null || event.providerActorFingerprint !== null
    )
  ))
  if (!events.length) return []
  const result = await client.query<RetainedEvent>(
    `SELECT event.id::text, event.event_hash, event.event_kind,
            event.tracking_number, event.tracking_url, event.provider_actor_fingerprint,
            event.sensitive_evidence_expires_at, event.sensitive_evidence_redacted_at,
            event.sensitive_evidence_expires_at <= clock_timestamp() AS expired,
            original.source_hash AS base_source_hash,
            original.provider_updated_at AS base_provider_updated_at,
            latest.id::text AS latest_id, latest.tracking_url AS latest_url,
            latest.provider_updated_at AS latest_provider_updated_at,
            matched.id::text AS matched_id, matched.tracking_url AS matched_url
     FROM operations_commerce_order_event_observations event
     JOIN operations_commerce_order_observations original
       ON original.organization_id = event.organization_id AND original.id = event.observation_id
     LEFT JOIN LATERAL (
       SELECT evidence.id, evidence.tracking_url, parent.provider_updated_at
       FROM operations_commerce_order_tracking_url_evidence evidence
       JOIN operations_commerce_order_observations parent
         ON parent.organization_id = evidence.organization_id AND parent.id = evidence.observation_id
       WHERE evidence.organization_id = event.organization_id AND evidence.base_event_id = event.id
       ORDER BY parent.provider_updated_at DESC NULLS LAST, parent.observed_at DESC,
                parent.id DESC, evidence.id DESC LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT evidence.id, evidence.tracking_url
       FROM operations_commerce_order_tracking_url_evidence evidence
       WHERE evidence.organization_id = event.organization_id AND evidence.base_event_id = event.id
         AND evidence.source_revision_hash = $6
       LIMIT 1
     ) matched ON true
     WHERE event.organization_id = $1::uuid AND event.integration_account_id = $2::uuid
       AND event.provider = $3 AND event.external_order_id = $4
       AND event.event_hash = ANY($5::text[])
     ORDER BY event.id FOR UPDATE OF event`,
    [scope.organizationId, scope.integrationAccountId, scope.provider,
      observation.externalOrderId, events.map((event) => event.eventHash), observation.sourceHash],
  )
  const byHash = new Map(result.rows.map((event) => [event.event_hash, event]))
  const enrichments = new Map<string, CommerceOrderTrackingUrlEnrichment>()
  const seen = new Map<string, Event>()
  for (const event of events) {
    const prior = seen.get(event.eventHash)
    if (prior && (prior.trackingNumber !== event.trackingNumber
      || prior.trackingUrl !== event.trackingUrl
      || prior.providerActorFingerprint !== event.providerActorFingerprint)) options.conflict()
    seen.set(event.eventHash, event)
    const retained = byHash.get(event.eventHash)
    if (!retained) {
      if (options.requireRetained && (event.trackingNumber !== null
        || event.trackingUrl !== null || event.providerActorFingerprint !== null)) options.conflict()
      continue
    }
    // Expiry, not the maintenance worker's timing, is the retention boundary.
    // Neither expired nor redacted evidence may be rehydrated by a fresh read.
    if (retained.expired) continue
    if (retained.sensitive_evidence_redacted_at !== null
      || retained.tracking_number !== event.trackingNumber
      || retained.provider_actor_fingerprint !== event.providerActorFingerprint) options.conflict()
    // An optional provider field omitted from this read is unavailable, not
    // evidence that a previously observed URL was removed.
    if (event.trackingUrl === null) continue
    // Older writers could retain a URL-aware parent hash while its base event
    // still had no URL. That initial absence can be repaired, but an admitted
    // overlay (or a positive base URL) remains immutable for the same revision.
    const knownRevision = retained.matched_id !== null
      || (retained.base_source_hash === observation.sourceHash && retained.tracking_url !== null)
    const retainedUrl = retained.matched_id !== null ? retained.matched_url
      : retained.base_source_hash === observation.sourceHash && retained.tracking_url !== null ? retained.tracking_url
        : retained.latest_id !== null ? retained.latest_url : retained.tracking_url
    if (retainedUrl === event.trackingUrl) continue
    if (knownRevision || event.eventKind !== 'tracking_updated' || !event.trackingUrl
      || !retained.tracking_number) options.conflict()
    const previousClock = retained.latest_id !== null
      ? retained.latest_provider_updated_at : retained.base_provider_updated_at
    const currentClock = observation.providerUpdatedAt
    if (!previousClock || !currentClock) options.conflict()
    const previousTime = previousClock.getTime()
    const currentTime = new Date(currentClock).getTime()
    if (currentTime < previousTime || (retainedUrl !== null && currentTime <= previousTime)) options.conflict()
    enrichments.set(retained.id, {
      baseEventId: retained.id, trackingUrl: event.trackingUrl,
      trackingNumber: event.trackingNumber, providerActorFingerprint: event.providerActorFingerprint,
      expiresAt: retained.sensitive_evidence_expires_at,
    })
  }
  return [...enrichments.values()]
}

/** A current observation must already have passed its normal lease/lineage
 * checks. No evidence is attached to the sealed observation being repaired. */
export async function appendCommerceOrderTrackingUrlEvidenceWithClient(
  client: PoolClient,
  scope: Scope,
  observation: Observation,
  observationId: string,
  enrichments: readonly CommerceOrderTrackingUrlEnrichment[],
) {
  for (const enrichment of enrichments) {
    const evidenceHash = createHash('sha256').update(JSON.stringify({
      version: 'commerce-order-tracking-url-v1', baseEventId: enrichment.baseEventId,
      sourceHash: observation.sourceHash,
    })).digest('hex')
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO operations_commerce_order_tracking_url_evidence (
         organization_id, integration_account_id, provider, external_order_id,
         base_event_id, observation_id, source_revision_hash, evidence_hash,
         tracking_url, tracking_number, provider_actor_fingerprint,
         sensitive_evidence_expires_at, observed_at
       ) SELECT $1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,
           base.sensitive_evidence_expires_at, parent.observed_at
         FROM operations_commerce_order_event_observations base
         JOIN operations_commerce_order_observations parent ON parent.organization_id=base.organization_id
           AND parent.id=$6::uuid
         WHERE base.organization_id=$1::uuid AND base.integration_account_id=$2::uuid AND base.id=$5::uuid
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [scope.organizationId, scope.integrationAccountId, scope.provider, observation.externalOrderId,
        enrichment.baseEventId, observationId, observation.sourceHash, evidenceHash,
        enrichment.trackingUrl, enrichment.trackingNumber, enrichment.providerActorFingerprint],
    )
    if (!inserted.rows[0]) throw new Error('Tracking URL evidence could not be appended under the current observation')
    if (inserted.rows[0]) await recordAuditEvent({
      actor: null, isSystem: true, eventType: 'commerce.order_history.tracking_url_observed',
      aggregateType: 'operations.commerce_order_event_observation', aggregateId: enrichment.baseEventId,
      organizationId: scope.organizationId, eventKey: `commerce-order-tracking-url:${inserted.rows[0].id}`,
      payload: { evidenceId: inserted.rows[0].id, observationId,
        baseEventId: enrichment.baseEventId, provider: scope.provider, providerWrites: 0 },
    }, client)
  }
}

/** Only callers' fixed SQL fragments are accepted, never request values. */
export function commerceOrderTrackingUrlEvidenceJoinSql(observationBoundarySql = 'TRUE') {
  return `LEFT JOIN LATERAL (
    SELECT evidence.id, evidence.tracking_url, evidence.sensitive_evidence_expires_at,
           evidence.sensitive_evidence_redacted_at
    FROM operations_commerce_order_tracking_url_evidence evidence
    JOIN operations_commerce_order_observations url_observation
      ON url_observation.organization_id = evidence.organization_id AND url_observation.id = evidence.observation_id
    WHERE evidence.organization_id = event.organization_id AND evidence.base_event_id = event.id
      AND evidence.integration_account_id = event.integration_account_id
      AND evidence.provider = event.provider AND evidence.external_order_id = event.external_order_id
      AND (${observationBoundarySql})
    ORDER BY url_observation.provider_updated_at DESC NULLS LAST, url_observation.observed_at DESC,
             url_observation.id DESC, evidence.id DESC LIMIT 1
  ) tracking_url_evidence ON true`
}

export const COMMERCE_ORDER_TRACKING_URL_VALUE_SQL = `CASE
  WHEN event.sensitive_evidence_expires_at > now() AND event.sensitive_evidence_redacted_at IS NULL THEN
    CASE WHEN tracking_url_evidence.id IS NULL THEN event.tracking_url
      WHEN tracking_url_evidence.sensitive_evidence_expires_at > now()
        AND tracking_url_evidence.sensitive_evidence_redacted_at IS NULL THEN tracking_url_evidence.tracking_url
      ELSE NULL END
  ELSE NULL END`
