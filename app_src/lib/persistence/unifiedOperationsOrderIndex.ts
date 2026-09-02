import type { PoolClient, QueryResultRow } from 'pg'
import type {
  OperationsOrderSortDirection,
  OperationsOrderTrackingFilter,
} from '@/lib/operations/orderListQuery'
import {
  EMPTY_OPERATIONS_ORDER_RESULT_SET_REVISION,
  type UnifiedOperationsOrderSort,
  type UnifiedOperationsOrderStatus,
} from '@/lib/operations/unifiedOrderPage'
import {
  externallyFulfilledOrderSql,
  latestExternalReconciliationTrackingSql,
  latestProviderTrackingSql,
} from './operations'

export type UnifiedOperationsOrderIndexEntry = {
  source: 'canonical' | 'imported'
  rowId: string
  provider: string
  integrationAccountGlobalId: string
  externalOrderId: string
}

export type UnifiedOperationsOrderIndexPage = {
  total: number
  offset: number
  revision: string
  entries: UnifiedOperationsOrderIndexEntry[]
}

type UnifiedIndexReadRow = QueryResultRow & {
  matching_total_count: string
  result_set_revision: string | null
  page_offset: string
  page_rows: unknown
}

function sortSql(input: {
  sort: UnifiedOperationsOrderSort
  direction: OperationsOrderSortDirection
}) {
  const direction = input.direction === 'asc' ? 'ASC' : 'DESC'
  if (input.sort === 'order_number') {
    return `provider_rank ASC,
            shopify_numeric_rank ${direction},
            shopify_number_length ${direction} NULLS LAST,
            shopify_number ${direction} NULLS LAST,
            order_number_key ${direction},
            source_rank ASC,
            row_id ASC`
  }
  const expression = input.sort === 'updated'
    ? 'activity_at'
    : input.sort === 'order_date'
      ? 'ordered_at'
      : 'customer_key'
  return `${expression} ${direction},
          provider_rank ASC,
          source_rank ASC,
          row_id ASC`
}

function validEntry(value: unknown): value is UnifiedOperationsOrderIndexEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<UnifiedOperationsOrderIndexEntry>
  return (
    (entry.source === 'canonical' || entry.source === 'imported')
    && typeof entry.rowId === 'string'
    && typeof entry.provider === 'string'
    && typeof entry.integrationAccountGlobalId === 'string'
    && typeof entry.externalOrderId === 'string'
  )
}

/**
 * Reads only the globally sorted row identities. The caller hydrates the two
 * source batches separately on this same repeatable-read client, keeping a
 * numbered page at one index query plus at most two bounded hydration queries.
 */
export async function readUnifiedOperationsOrderIndexPage(input: {
  client: PoolClient
  organizationId: string
  search: string
  status: UnifiedOperationsOrderStatus | null
  sort: UnifiedOperationsOrderSort
  direction: OperationsOrderSortDirection
  provider: string | null
  tracking: OperationsOrderTrackingFilter | null
  updatedAfter: string | null
  page: number
  pageSize: number
}): Promise<UnifiedOperationsOrderIndexPage> {
  const searchPattern = input.search
    ? `%${input.search.replace(/[!%_]/gu, '!$&')}%`
    : null
  const orderBy = sortSql(input)
  const result = await input.client.query<UnifiedIndexReadRow>(
    `WITH canonical_context AS MATERIALIZED (
       SELECT 'canonical'::text AS source_kind,
              orders.id AS row_id,
              orders.source_provider AS provider,
              source_account.global_id AS integration_account_global_id,
              orders.external_order_id,
              orders.order_number,
              customer.name AS customer_name,
              date_trunc('milliseconds', COALESCE(
                origin_candidate.provider_created_at,
                origin_candidate.observed_at,
                orders.imported_at,
                orders.created_at
              )) AS ordered_at,
              order_activity.activity_at,
              latest_tracking.tracking_number,
              CASE
                WHEN ${externallyFulfilledOrderSql('orders')}
                  THEN 'fulfilled_externally'
                ELSE orders.status::text
              END AS display_status
       FROM operations_orders orders
       JOIN crm_organizations customer
         ON customer.id = orders.customer_id
        AND customer.pipeline_id = orders.pipeline_id
       JOIN operations_integration_accounts source_account
         ON source_account.organization_id = orders.organization_id
        AND source_account.id = orders.integration_account_id
       LEFT JOIN operations_commerce_order_candidates origin_candidate
         ON origin_candidate.organization_id = orders.organization_id
        AND origin_candidate.canonical_order_id = orders.id
       LEFT JOIN LATERAL (
         SELECT candidate.tracking_number,
                COALESCE(candidate.shipped_at, candidate.created_at)
                  AS activity_at
         FROM operations_shipments candidate
         WHERE candidate.organization_id = orders.organization_id
           AND candidate.order_id = orders.id
         ORDER BY candidate.shipped_at DESC NULLS LAST,
                  candidate.created_at DESC,
                  candidate.id DESC
         LIMIT 1
       ) latest_shipment ON true
       LEFT JOIN LATERAL (
         ${latestProviderTrackingSql('orders')}
       ) latest_provider_tracking ON true
       LEFT JOIN LATERAL (
         ${latestExternalReconciliationTrackingSql('orders')}
       ) latest_external_reconciliation ON true
       LEFT JOIN LATERAL (
         SELECT date_trunc('milliseconds', max(GREATEST(
                  event.occurred_at,
                  event.observed_at,
                  event.created_at
                ))) AS activity_at
         FROM operations_commerce_order_event_observations event
         WHERE event.organization_id = orders.organization_id
           AND (
             event.order_id = orders.id
             OR (
               event.order_id IS NULL
               AND event.integration_account_id = orders.integration_account_id
               AND event.provider = orders.source_provider
               AND event.external_order_id = orders.external_order_id
             )
           )
       ) provider_event_activity ON true
       LEFT JOIN LATERAL (
         SELECT date_trunc('milliseconds', max(GREATEST(
                  observation.observed_at,
                  COALESCE(observation.provider_updated_at, observation.observed_at),
                  observation.created_at
                ))) AS activity_at
         FROM operations_commerce_order_observations observation
         WHERE observation.organization_id = orders.organization_id
           AND (
             observation.order_id = orders.id
             OR (
               observation.order_id IS NULL
               AND observation.integration_account_id = orders.integration_account_id
               AND observation.provider = orders.source_provider
               AND observation.external_order_id = orders.external_order_id
             )
           )
       ) provider_order_activity ON true
       LEFT JOIN LATERAL (
         SELECT date_trunc('milliseconds', max(GREATEST(
                  observation.observed_at,
                  observation.created_at
                ))) AS activity_at
         FROM operations_commerce_order_revision_observations observation
         WHERE observation.organization_id = orders.organization_id
           AND observation.order_id = orders.id
       ) revision_observation_activity ON true
       LEFT JOIN LATERAL (
         SELECT date_trunc('milliseconds', max(GREATEST(
                  provider_read.observed_at,
                  provider_read.created_at
                ))) AS activity_at
         FROM operations_commerce_order_revision_reads provider_read
         WHERE provider_read.organization_id = orders.organization_id
           AND provider_read.order_id = orders.id
       ) revision_read_activity ON true
       LEFT JOIN LATERAL (
         SELECT evidence.tracking_number
         FROM (VALUES
           (latest_shipment.tracking_number, latest_shipment.activity_at, 1),
           (latest_provider_tracking.tracking_number,
            latest_provider_tracking.activity_at, 2),
           (latest_external_reconciliation.tracking_number,
            latest_external_reconciliation.activity_at, 3)
         ) AS evidence(tracking_number, activity_at, source_priority)
         WHERE evidence.activity_at IS NOT NULL
         ORDER BY (evidence.tracking_number IS NOT NULL) DESC,
                  evidence.activity_at DESC NULLS LAST,
                  evidence.source_priority ASC
         LIMIT 1
       ) latest_tracking ON true
       CROSS JOIN LATERAL (
         SELECT date_trunc('milliseconds', GREATEST(
                  orders.updated_at,
                  COALESCE(latest_shipment.activity_at, orders.updated_at),
                  COALESCE(provider_event_activity.activity_at, orders.updated_at),
                  COALESCE(provider_order_activity.activity_at, orders.updated_at),
                  COALESCE(revision_observation_activity.activity_at, orders.updated_at),
                  COALESCE(revision_read_activity.activity_at, orders.updated_at),
                  COALESCE(latest_external_reconciliation.activity_at, orders.updated_at)
                )) AS activity_at
       ) order_activity
       WHERE orders.organization_id = $1::uuid
         AND orders.archived_at IS NULL
         AND (
           $2::text IS NULL
           OR orders.order_number ILIKE $2 ESCAPE '!'
           OR orders.global_id ILIKE $2 ESCAPE '!'
           OR orders.external_order_id ILIKE $2 ESCAPE '!'
           OR customer.name ILIKE $2 ESCAPE '!'
           OR customer.reference_code ILIKE $2 ESCAPE '!'
           OR latest_tracking.tracking_number ILIKE $2 ESCAPE '!'
           OR EXISTS (
             SELECT 1
             FROM operations_current_order_lines line
             LEFT JOIN crm_products product
               ON product.pipeline_id = line.pipeline_id
              AND product.id = line.product_id
             WHERE line.organization_id = orders.organization_id
               AND line.order_id = orders.id
               AND (
                 line.channel_sku ILIKE $2 ESCAPE '!'
                 OR COALESCE(product.sku, '') ILIKE $2 ESCAPE '!'
                 OR product.reference_code ILIKE $2 ESCAPE '!'
               )
           )
         )
         AND (
           $3::text IS NULL
           OR ($3::text = 'fulfilled_externally'
               AND ${externallyFulfilledOrderSql('orders')})
           OR ($3::text NOT IN ('fulfilled_externally', 'closed_externally')
               AND orders.status::text = $3::text
               AND NOT (${externallyFulfilledOrderSql('orders')}))
         )
         AND ($4::text IS NULL OR orders.source_provider = $4::text)
         AND (
           $5::text IS NULL
           OR ($5::text = 'present' AND latest_tracking.tracking_number IS NOT NULL)
           OR ($5::text = 'missing' AND latest_tracking.tracking_number IS NULL)
         )
         AND ($6::timestamptz IS NULL OR order_activity.activity_at > $6::timestamptz)
     ), latest_live_candidates AS MATERIALIZED (
       SELECT DISTINCT ON (
         candidate.integration_account_id,
         candidate.external_order_id
       ) candidate.id,
         candidate.organization_id,
         candidate.integration_account_id,
         candidate.external_order_id
       FROM operations_commerce_order_candidates candidate
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = candidate.organization_id
        AND run.integration_account_id = candidate.integration_account_id
        AND run.pipeline_id = candidate.pipeline_id
        AND run.id = candidate.run_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.canonical_order_id IS NULL
         AND candidate.workflow_state IN ('held', 'resolving', 'ready')
         AND candidate.expires_at > now()
         AND run.expires_at > now()
         AND run.workflow_state <> 'expired'
         AND NOT EXISTS (
           SELECT 1
           FROM operations_orders canonical
           WHERE canonical.organization_id = candidate.organization_id
             AND canonical.integration_account_id = candidate.integration_account_id
             AND canonical.external_order_id = candidate.external_order_id
         )
       ORDER BY candidate.integration_account_id,
                candidate.external_order_id,
                candidate.observed_at DESC,
                candidate.created_at DESC,
                candidate.id DESC
     ), selected_candidate_ids AS MATERIALIZED (
       SELECT live.id AS candidate_id
       FROM latest_live_candidates live
       WHERE NOT EXISTS (
         SELECT 1
         FROM operations_commerce_order_workbench retained
         WHERE retained.organization_id = live.organization_id
           AND retained.integration_account_id = live.integration_account_id
           AND retained.external_order_id = live.external_order_id
       )
       UNION ALL
       SELECT retained.candidate_id
       FROM operations_commerce_order_workbench retained
       JOIN operations_commerce_order_candidates retained_candidate
         ON retained_candidate.organization_id = retained.organization_id
        AND retained_candidate.integration_account_id = retained.integration_account_id
        AND retained_candidate.id = retained.candidate_id
       WHERE retained.organization_id = $1::uuid
         AND retained.canonical_order_id IS NULL
         AND retained_candidate.canonical_order_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM operations_orders canonical
           WHERE canonical.organization_id = retained_candidate.organization_id
             AND canonical.integration_account_id = retained_candidate.integration_account_id
             AND canonical.external_order_id = retained_candidate.external_order_id
         )
     ), imported_base AS MATERIALIZED (
       SELECT candidate.id AS row_id,
              candidate.integration_account_id,
              candidate.external_order_id,
              candidate.provider,
              candidate.global_id,
              candidate.normalized_order_status,
              candidate.normalized_fulfillment_status,
              candidate.observed_at AS retained_observed_at,
              candidate.created_at AS retained_created_at,
              workbench.updated_at AS workbench_updated_at,
              latest_provider.id AS latest_provider_candidate_id,
              latest_provider.provider_created_at AS latest_provider_created_at,
              latest_provider.provider_updated_at AS latest_provider_updated_at,
              latest_provider.observed_at AS latest_provider_observed_at,
              latest_status.lifecycle_status,
              latest_status.fulfillment_status,
              latest_status.observed_at AS latest_status_observed_at,
              latest_observation.provider_created_at AS observation_created_at,
              latest_observation.provider_updated_at AS observation_updated_at,
              latest_observation.observed_at AS observation_observed_at,
              latest_tracking.tracking_number,
              latest_tracking.activity_at AS tracking_activity_at
       FROM selected_candidate_ids selected
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = $1::uuid
        AND candidate.id = selected.candidate_id
       LEFT JOIN operations_commerce_order_workbench workbench
         ON workbench.organization_id = candidate.organization_id
        AND workbench.integration_account_id = candidate.integration_account_id
        AND workbench.external_order_id = candidate.external_order_id
       LEFT JOIN LATERAL (
         SELECT provider_candidate.id,
                provider_candidate.provider_created_at,
                provider_candidate.provider_updated_at,
                provider_candidate.observed_at
         FROM operations_commerce_order_candidates provider_candidate
         WHERE provider_candidate.organization_id = candidate.organization_id
           AND provider_candidate.integration_account_id = candidate.integration_account_id
           AND provider_candidate.external_order_id = candidate.external_order_id
           AND provider_candidate.workflow_state <> 'failed'
         ORDER BY COALESCE(provider_candidate.provider_updated_at,
                           provider_candidate.observed_at) DESC,
                  provider_candidate.observed_at DESC,
                  provider_candidate.created_at DESC,
                  provider_candidate.id DESC
         LIMIT 1
       ) latest_provider ON true
       LEFT JOIN LATERAL (
         SELECT status_evidence.lifecycle_status,
                status_evidence.fulfillment_status,
                status_evidence.observed_at
         FROM (
           SELECT provider_candidate.normalized_order_status AS lifecycle_status,
                  provider_candidate.normalized_fulfillment_status AS fulfillment_status,
                  provider_candidate.provider_updated_at,
                  provider_candidate.observed_at,
                  0::integer AS source_priority,
                  provider_candidate.id AS evidence_id
           FROM operations_commerce_order_candidates provider_candidate
           WHERE provider_candidate.organization_id = candidate.organization_id
             AND provider_candidate.integration_account_id = candidate.integration_account_id
             AND provider_candidate.external_order_id = candidate.external_order_id
             AND provider_candidate.workflow_state <> 'failed'
           UNION ALL
           SELECT observation.canonical_lifecycle_state,
                  observation.canonical_fulfillment_state,
                  observation.provider_updated_at,
                  observation.observed_at,
                  1::integer,
                  observation.id
           FROM operations_commerce_order_observations observation
           WHERE observation.organization_id = candidate.organization_id
             AND observation.integration_account_id = candidate.integration_account_id
             AND observation.provider = candidate.provider
             AND observation.external_order_id = candidate.external_order_id
         ) status_evidence
         ORDER BY COALESCE(status_evidence.provider_updated_at,
                           status_evidence.observed_at) DESC,
                  status_evidence.observed_at DESC,
                  status_evidence.source_priority DESC,
                  status_evidence.evidence_id DESC
         LIMIT 1
       ) latest_status ON true
       LEFT JOIN LATERAL (
         SELECT observation.provider_created_at,
                observation.provider_updated_at,
                observation.observed_at
         FROM operations_commerce_order_observations observation
         WHERE observation.organization_id = candidate.organization_id
           AND observation.integration_account_id = candidate.integration_account_id
           AND observation.provider = candidate.provider
           AND observation.external_order_id = candidate.external_order_id
         ORDER BY COALESCE(observation.provider_updated_at,
                           observation.observed_at) DESC,
                  observation.observed_at DESC,
                  observation.id DESC
         LIMIT 1
       ) latest_observation ON true
       LEFT JOIN LATERAL (
         SELECT (array_remove(array_agg(
                  subject_state.tracking_number
                  ORDER BY subject_state.activity_at DESC,
                           subject_state.subject_key,
                           subject_state.event_id DESC
                ), NULL))[1] AS tracking_number,
                max(subject_state.activity_at) AS activity_at
         FROM (
           SELECT ranked.subject_key,
                  ranked.event_id,
                  ranked.tracking_number,
                  ranked.activity_at
           FROM (
             SELECT COALESCE(NULLIF(btrim(event.external_subject_id), ''),
                             '__order__') AS subject_key,
                    event.id AS event_id,
                    CASE
                      WHEN event.sensitive_evidence_redacted_at IS NULL
                       AND event.sensitive_evidence_expires_at > now()
                        THEN NULLIF(btrim(event.tracking_number), '')
                      ELSE NULL
                    END AS tracking_number,
                    date_trunc('milliseconds', GREATEST(
                      event.occurred_at,
                      event.observed_at,
                      event.created_at
                    )) AS activity_at,
                    row_number() OVER (
                      PARTITION BY COALESCE(
                        NULLIF(btrim(event.external_subject_id), ''),
                        '__order__'
                      )
                      ORDER BY GREATEST(
                                 event.occurred_at,
                                 event.observed_at,
                                 event.created_at
                               ) DESC,
                               (NULLIF(btrim(event.tracking_number), '')
                                  IS NOT NULL) DESC,
                               event.external_event_id DESC NULLS LAST,
                               event.id DESC
                    ) AS subject_rank
             FROM operations_commerce_order_event_observations event
             WHERE event.organization_id = candidate.organization_id
               AND event.integration_account_id = candidate.integration_account_id
               AND event.provider = candidate.provider
               AND event.external_order_id = candidate.external_order_id
               AND event.event_kind = 'tracking_updated'
           ) ranked
           WHERE ranked.subject_rank = 1
         ) subject_state
       ) latest_tracking ON true
     ), imported_context AS MATERIALIZED (
       SELECT 'imported'::text AS source_kind,
              base.row_id,
              display_snapshot.provider,
              source_account.global_id AS integration_account_global_id,
              source_account.display_name AS integration_account_name,
              base.external_order_id,
              display_snapshot.order_number_snapshot AS order_number,
              display_customer.name AS customer_name,
              date_trunc('milliseconds', COALESCE(
                base.observation_created_at,
                base.latest_provider_created_at,
                display_snapshot.provider_created_at,
                display_snapshot.observed_at
              )) AS ordered_at,
              date_trunc('milliseconds', GREATEST(
                COALESCE(base.latest_provider_updated_at,
                         base.latest_provider_observed_at),
                COALESCE(base.observation_updated_at,
                         base.observation_observed_at),
                base.tracking_activity_at,
                base.retained_observed_at,
                base.workbench_updated_at
              )) AS activity_at,
              base.tracking_number,
              CASE
                WHEN COALESCE(base.lifecycle_status,
                              base.normalized_order_status)
                       IN ('cancelled', 'canceled')
                  OR COALESCE(base.fulfillment_status,
                              base.normalized_fulfillment_status)
                       IN ('cancelled', 'canceled')
                  THEN 'cancelled'
                WHEN COALESCE(base.fulfillment_status,
                              base.normalized_fulfillment_status) = 'fulfilled'
                  THEN 'fulfilled_externally'
                WHEN COALESCE(base.lifecycle_status,
                              base.normalized_order_status) = 'closed'
                  THEN 'closed_externally'
                ELSE 'imported'
              END AS display_status,
              base.latest_provider_candidate_id,
              base.integration_account_id,
              base.global_id
       FROM imported_base base
       CROSS JOIN LATERAL (
         SELECT CASE
           WHEN COALESCE(base.lifecycle_status, base.normalized_order_status)
                  IN ('cancelled', 'canceled', 'closed')
             OR COALESCE(base.fulfillment_status,
                         base.normalized_fulfillment_status)
                  IN ('fulfilled', 'cancelled', 'canceled')
             THEN COALESCE(base.latest_provider_candidate_id, base.row_id)
           ELSE base.row_id
         END AS id
       ) display_candidate
       JOIN operations_commerce_order_candidates display_snapshot
         ON display_snapshot.organization_id = $1::uuid
        AND display_snapshot.id = display_candidate.id
       JOIN operations_integration_accounts source_account
         ON source_account.organization_id = display_snapshot.organization_id
        AND source_account.id = base.integration_account_id
        AND source_account.integration_type = 'commerce'
        AND source_account.provider IN ('shopify', 'faire')
       LEFT JOIN crm_organizations display_customer
         ON display_customer.pipeline_id = display_snapshot.pipeline_id
        AND display_customer.id = display_snapshot.customer_id
     ), imported_filtered AS MATERIALIZED (
       SELECT imported.*
       FROM imported_context imported
       WHERE (
           $2::text IS NULL
           OR imported.global_id ILIKE $2 ESCAPE '!'
           OR imported.order_number ILIKE $2 ESCAPE '!'
           OR imported.external_order_id ILIKE $2 ESCAPE '!'
           OR imported.integration_account_name ILIKE $2 ESCAPE '!'
           OR imported.provider ILIKE $2 ESCAPE '!'
           OR COALESCE(imported.customer_name, '') ILIKE $2 ESCAPE '!'
           OR imported.tracking_number ILIKE $2 ESCAPE '!'
           OR EXISTS (
             SELECT 1
             FROM operations_commerce_order_candidate_lines line
             LEFT JOIN crm_products product
               ON product.pipeline_id = line.pipeline_id
              AND product.id = line.product_id
             WHERE line.organization_id = $1::uuid
               AND line.integration_account_id = imported.integration_account_id
               AND line.order_candidate_id IN (
                 imported.row_id,
                 imported.latest_provider_candidate_id
               )
               AND (
                 COALESCE(line.sku_snapshot, '') ILIKE $2 ESCAPE '!'
                 OR COALESCE(product.sku, '') ILIKE $2 ESCAPE '!'
                 OR product.reference_code ILIKE $2 ESCAPE '!'
               )
           )
           OR EXISTS (
             SELECT 1
             FROM operations_commerce_order_observations observation
             JOIN operations_commerce_order_observation_lines line
               ON line.organization_id = observation.organization_id
              AND line.observation_id = observation.id
             WHERE observation.organization_id = $1::uuid
               AND observation.integration_account_id
                 = imported.integration_account_id
               AND observation.provider = imported.provider
               AND observation.external_order_id
                 = imported.external_order_id
               AND COALESCE(line.sku, '') ILIKE $2 ESCAPE '!'
           )
         )
         AND ($3::text IS NULL OR imported.display_status = $3::text)
         AND ($4::text IS NULL OR imported.provider = $4::text)
         AND (
           $5::text IS NULL
           OR ($5::text = 'present' AND imported.tracking_number IS NOT NULL)
           OR ($5::text = 'missing' AND imported.tracking_number IS NULL)
         )
         AND ($6::timestamptz IS NULL OR imported.activity_at > $6::timestamptz)
     ), unified_rows AS MATERIALIZED (
       SELECT canonical.* FROM canonical_context canonical
       UNION ALL
       SELECT imported.source_kind,
              imported.row_id,
              imported.provider,
              imported.integration_account_global_id,
              imported.external_order_id,
              imported.order_number,
              imported.customer_name,
              imported.ordered_at,
              imported.activity_at,
              imported.tracking_number,
              imported.display_status
       FROM imported_filtered imported
     ), sortable_rows AS MATERIALIZED (
       SELECT unified.*,
              CASE lower(unified.provider)
                WHEN 'shopify' THEN 0
                WHEN 'faire' THEN 1
                ELSE 2
              END AS provider_rank,
              CASE unified.source_kind
                WHEN 'canonical' THEN 0
                ELSE 1
              END AS source_rank,
              lower(left(COALESCE(unified.customer_name, ''), 512))
                COLLATE "C" AS customer_key,
              lower(left(unified.order_number, 512)) COLLATE "C"
                AS order_number_key,
              CASE
                WHEN lower(unified.provider) = 'shopify'
                 AND regexp_replace(btrim(unified.order_number), '^#', '')
                       ~ '^[0-9]+$'
                  THEN 0
                WHEN lower(unified.provider) = 'shopify' THEN 1
                ELSE 0
              END AS shopify_numeric_rank,
              CASE
                WHEN lower(unified.provider) = 'shopify'
                 AND regexp_replace(btrim(unified.order_number), '^#', '')
                       ~ '^[0-9]+$'
                  THEN length(COALESCE(NULLIF(ltrim(
                    regexp_replace(btrim(unified.order_number), '^#', ''), '0'
                  ), ''), '0'))
                ELSE NULL
              END AS shopify_number_length,
              CASE
                WHEN lower(unified.provider) = 'shopify'
                 AND regexp_replace(btrim(unified.order_number), '^#', '')
                       ~ '^[0-9]+$'
                  THEN COALESCE(NULLIF(ltrim(
                    regexp_replace(btrim(unified.order_number), '^#', ''), '0'
                  ), ''), '0') COLLATE "C"
                ELSE NULL
              END AS shopify_number
       FROM unified_rows unified
     ), evidence AS MATERIALIZED (
       SELECT count(*)::bigint AS matching_total_count,
              COALESCE(md5(string_agg(
                jsonb_build_array(
                  sortable.source_kind,
                  sortable.row_id::text,
                  sortable.provider,
                  sortable.integration_account_global_id,
                  sortable.external_order_id,
                  sortable.order_number,
                  sortable.customer_name,
                  sortable.ordered_at,
                  sortable.activity_at,
                  sortable.tracking_number,
                  sortable.display_status
                )::text,
                E'\n' ORDER BY sortable.source_kind, sortable.row_id
              )), '${EMPTY_OPERATIONS_ORDER_RESULT_SET_REVISION}')
                AS result_set_revision
       FROM sortable_rows sortable
     ), ranked_rows AS MATERIALIZED (
       SELECT sortable.*,
              row_number() OVER (ORDER BY ${orderBy}) AS position
       FROM sortable_rows sortable
     ), page_bounds AS (
       SELECT CASE
         WHEN evidence.matching_total_count = 0 THEN 0::bigint
         ELSE LEAST(
           (($7::bigint - 1) * $8::bigint),
           ((evidence.matching_total_count - 1) / $8::bigint) * $8::bigint
         )
       END AS page_offset
       FROM evidence
     )
     SELECT evidence.matching_total_count::text,
            evidence.result_set_revision,
            page_bounds.page_offset::text,
            COALESCE(jsonb_agg(jsonb_build_object(
              'source', ranked.source_kind,
              'rowId', ranked.row_id::text,
              'provider', ranked.provider,
              'integrationAccountGlobalId', ranked.integration_account_global_id,
              'externalOrderId', ranked.external_order_id
            ) ORDER BY ranked.position) FILTER (
              WHERE ranked.row_id IS NOT NULL
            ), '[]'::jsonb) AS page_rows
     FROM evidence
     CROSS JOIN page_bounds
     LEFT JOIN ranked_rows ranked
       ON ranked.position > page_bounds.page_offset
      AND ranked.position <= page_bounds.page_offset + $8::bigint
     GROUP BY evidence.matching_total_count,
              evidence.result_set_revision,
              page_bounds.page_offset`,
    [
      input.organizationId,
      searchPattern,
      input.status,
      input.provider,
      input.tracking,
      input.updatedAfter,
      input.page,
      input.pageSize,
    ],
  )
  const row = result.rows[0]
  const total = Number(row?.matching_total_count ?? 0)
  const offset = Number(row?.page_offset ?? 0)
  const revision = String(
    row?.result_set_revision || EMPTY_OPERATIONS_ORDER_RESULT_SET_REVISION,
  )
  const entries = Array.isArray(row?.page_rows) ? row.page_rows : []
  if (
    !Number.isSafeInteger(total)
    || total < 0
    || !Number.isSafeInteger(offset)
    || offset < 0
    || offset > total
    || !/^[0-9a-f]{32}$/u.test(revision)
    || !entries.every(validEntry)
    || entries.length > input.pageSize
  ) {
    throw new Error('Unified order index returned invalid page evidence')
  }
  return { total, offset, revision, entries }
}
