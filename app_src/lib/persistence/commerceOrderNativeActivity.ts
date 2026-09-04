import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'

type Scope = {
  organizationId: string
  integrationAccountId: string
  provider: 'shopify' | 'faire'
}
type NativeEvent = {
  eventHash: string
  eventKind: string
  eventStatus: string | null
  providerMessage?: string | null
  providerActorDisplayName?: string | null
}
type Observation = {
  externalOrderId: string
  sourceHash: string
  observedAt: string
  events: readonly NativeEvent[]
}
export type CommerceOrderNativeActivitySnapshot = {
  eventHash: string
  providerAction: string | null
  providerMessage: string | null
  providerActorDisplayName: string | null
}
type Retained = {
  event_hash: string
  expired: boolean
  sensitive_evidence_redacted_at: Date | null
  latest_id: string | null
  provider_action: string | null
  provider_message: string | null
  provider_actor_display_name: string | null
  latest_observed_at: Date | null
  latest_redacted_at: Date | null
}

/** Caller holds the existing per-order lock. Native text is mutable provider
 * content, not an immutable stock/revision fact. Compare only the latest
 * capture; a genuine A -> B -> A edit is a new snapshot, not a conflict. */
export async function inspectCommerceOrderNativeActivityWithClient(
  client: PoolClient,
  scope: Scope,
  observation: Observation,
): Promise<CommerceOrderNativeActivitySnapshot[]> {
  const events = observation.events.filter((event) => event.eventKind === 'provider_activity')
  if (!events.length || scope.provider !== 'shopify') return []
  const retained = await client.query<Retained>(
    `SELECT event.event_hash,
            event.sensitive_evidence_expires_at <= clock_timestamp() AS expired,
            event.sensitive_evidence_redacted_at,
            latest.id::text AS latest_id, latest.provider_action,
            latest.provider_message, latest.provider_actor_display_name,
            latest.observed_at AS latest_observed_at,
            latest.sensitive_evidence_redacted_at AS latest_redacted_at
     FROM operations_commerce_order_event_observations event
     LEFT JOIN LATERAL (
       SELECT evidence.*
       FROM operations_commerce_order_native_activity_evidence evidence
       WHERE evidence.organization_id = event.organization_id
         AND evidence.integration_account_id = event.integration_account_id
         AND evidence.provider = event.provider
         AND evidence.external_order_id = event.external_order_id
         AND evidence.base_event_id = event.id
       ORDER BY evidence.observed_at DESC, evidence.id DESC LIMIT 1
     ) latest ON true
     WHERE event.organization_id = $1::uuid AND event.integration_account_id = $2::uuid
       AND event.provider = $3 AND event.external_order_id = $4
       AND event.event_kind = 'provider_activity' AND event.event_hash = ANY($5::text[])
     ORDER BY event.id FOR UPDATE OF event`,
    [scope.organizationId, scope.integrationAccountId, scope.provider,
      observation.externalOrderId, events.map((event) => event.eventHash)],
  )
  const byHash = new Map(retained.rows.map((row) => [row.event_hash, row]))
  const snapshots = new Map<string, CommerceOrderNativeActivitySnapshot>()
  for (const event of events) {
    const previous = byHash.get(event.eventHash)
    // Expiry/manual redaction is irreversible, including a read racing cleanup.
    if (previous && (previous.expired || previous.sensitive_evidence_redacted_at
      || previous.latest_redacted_at)) continue
    const snapshot = {
      eventHash: event.eventHash,
      providerAction: event.eventStatus,
      providerMessage: event.providerMessage ?? null,
      providerActorDisplayName: event.providerActorDisplayName ?? null,
    }
    if (previous?.latest_id) {
      if (previous.provider_action === snapshot.providerAction
        && previous.provider_message === snapshot.providerMessage
        && previous.provider_actor_display_name === snapshot.providerActorDisplayName) continue
      // A later-finishing stale read must not become the latest provider note.
      if (previous.latest_observed_at
        && new Date(observation.observedAt).getTime() <= previous.latest_observed_at.getTime()) continue
    }
    snapshots.set(event.eventHash, snapshot)
  }
  return [...snapshots.values()]
}

/** Called after normal base-event insertion under the fresh authorized parent.
 * The migration trigger independently fences parent, account and base identity.
 * No personal text or display name participates in a durable hash or audit. */
export async function appendCommerceOrderNativeActivityWithClient(
  client: PoolClient,
  scope: Scope,
  observation: Observation,
  observationId: string,
  snapshots: readonly CommerceOrderNativeActivitySnapshot[],
) {
  if (!snapshots.length) return
  const values = snapshots.map((snapshot) => ({
    ...snapshot,
    evidenceHash: createHash('sha256').update(JSON.stringify({
      version: 'commerce-order-native-activity-v1',
      eventHash: snapshot.eventHash, observationId,
    })).digest('hex'),
  }))
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO operations_commerce_order_native_activity_evidence (
       organization_id, integration_account_id, provider, external_order_id,
       base_event_id, observation_id, source_revision_hash, evidence_hash,
       provider_action, provider_message, provider_actor_display_name,
       sensitive_evidence_expires_at, observed_at
     )
     SELECT event.organization_id, event.integration_account_id, event.provider,
       event.external_order_id, event.id, $5::uuid, $7, incoming."evidenceHash",
       incoming."providerAction", incoming."providerMessage", incoming."providerActorDisplayName",
       event.sensitive_evidence_expires_at, parent.observed_at
     FROM jsonb_to_recordset($6::jsonb) AS incoming(
       "eventHash" text, "evidenceHash" text, "providerAction" text,
       "providerMessage" text, "providerActorDisplayName" text)
     JOIN operations_commerce_order_event_observations event
       ON event.organization_id = $1::uuid AND event.integration_account_id = $2::uuid
       AND event.provider = $3 AND event.external_order_id = $4
       AND event.event_kind = 'provider_activity' AND event.event_hash = incoming."eventHash"
     JOIN operations_commerce_order_observations parent
       ON parent.id = $5::uuid AND parent.organization_id = event.organization_id
       AND parent.integration_account_id = event.integration_account_id
       AND parent.provider = event.provider AND parent.external_order_id = event.external_order_id
       AND parent.source_hash = $7
     WHERE event.sensitive_evidence_expires_at > clock_timestamp()
       AND event.sensitive_evidence_redacted_at IS NULL
     ON CONFLICT DO NOTHING RETURNING id::text`,
    [scope.organizationId, scope.integrationAccountId, scope.provider,
      observation.externalOrderId, observationId, JSON.stringify(values),
      observation.sourceHash],
  )
  if (inserted.rows.length) await recordAuditEvent({
    actor: null, isSystem: true, eventType: 'commerce.order_history.native_activity_observed',
    aggregateType: 'operations.commerce_order_observation', aggregateId: observationId,
    organizationId: scope.organizationId,
    eventKey: `commerce-order-native-activity:${observationId}`,
    payload: { observationId, evidenceCount: inserted.rows.length,
      provider: scope.provider, providerWrites: 0 },
  }, client)
}

/** Only fixed caller-owned SQL fragments, never request text. The boundary
 * uses native_observation so as-of readers cannot leak a later edited note. */
export function commerceOrderNativeActivityJoinSql(observationBoundarySql = 'TRUE') {
  return `LEFT JOIN LATERAL (
    SELECT evidence.*
    FROM operations_commerce_order_native_activity_evidence evidence
    JOIN operations_commerce_order_observations native_observation
      ON native_observation.organization_id = evidence.organization_id
      AND native_observation.id = evidence.observation_id
    WHERE evidence.organization_id = event.organization_id
      AND evidence.integration_account_id = event.integration_account_id
      AND evidence.provider = event.provider AND evidence.external_order_id = event.external_order_id
      AND evidence.base_event_id = event.id AND (${observationBoundarySql})
    ORDER BY evidence.observed_at DESC, evidence.id DESC LIMIT 1
  ) native_activity_evidence ON true`
}

const RETAINED_NATIVE = `event.sensitive_evidence_expires_at > now()
  AND event.sensitive_evidence_redacted_at IS NULL
  AND native_activity_evidence.sensitive_evidence_expires_at > now()
  AND native_activity_evidence.sensitive_evidence_redacted_at IS NULL`
export const COMMERCE_ORDER_NATIVE_MESSAGE_SQL = `CASE WHEN ${RETAINED_NATIVE}
  THEN native_activity_evidence.provider_message ELSE NULL END`
export const COMMERCE_ORDER_NATIVE_ACTOR_SQL = `CASE WHEN ${RETAINED_NATIVE}
  THEN native_activity_evidence.provider_actor_display_name ELSE NULL END`
export const COMMERCE_ORDER_NATIVE_ACTION_SQL = `CASE WHEN event.event_kind = 'provider_activity'
  THEN CASE WHEN ${RETAINED_NATIVE} THEN native_activity_evidence.provider_action ELSE NULL END
  ELSE event.event_status END`
export const COMMERCE_ORDER_NATIVE_REDACTED_SQL = `(event.event_kind = 'provider_activity'
  AND (event.sensitive_evidence_expires_at <= now()
    OR event.sensitive_evidence_redacted_at IS NOT NULL
    OR native_activity_evidence.sensitive_evidence_expires_at <= now()
    OR native_activity_evidence.sensitive_evidence_redacted_at IS NOT NULL))`
