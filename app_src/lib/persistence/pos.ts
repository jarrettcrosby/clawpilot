import { query } from '@/lib/persistence/postgres'
import { readToastIntegrationStateFromPostgres } from '@/lib/persistence/toastIntegrations'

type TimestampValue = string | Date

type PosOrderRow = {
  order_guid: string
  restaurant_guid: string
  restaurant_name: string
  business_date: TimestampValue
  display_number: string | null
  source: string | null
  dining_option: string | null
  approval_status: string | null
  payment_status: string | null
  opened_at: TimestampValue | null
  closed_at: TimestampValue | null
  paid_at: TimestampValue | null
  created_at_source: TimestampValue | null
  modified_at_source: TimestampValue | null
  promised_at: TimestampValue | null
  estimated_fulfillment_at: TimestampValue | null
  payment_business_dates: TimestampValue[]
  fulfillment_business_date: TimestampValue
  guest_count: number
  check_count: number
  item_count: string
  gross_sales: string
  net_sales: string
  discounts: string
  tax: string
  service_charges: string
  tips: string
  refunds: string
  tendered: string
  total: string
  cash_tender: string
  card_tender: string
  other_tender: string
  voided: boolean
  deleted: boolean
  details?: Record<string, unknown>
}

function numberValue(value: string | number | null | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function dateOnly(value: TimestampValue | null | undefined) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10)
}

function posOrder(row: PosOrderRow) {
  return {
    orderGuid: row.order_guid,
    restaurantGuid: row.restaurant_guid,
    restaurantName: row.restaurant_name,
    businessDate: dateOnly(row.business_date),
    displayNumber: row.display_number,
    source: row.source,
    diningOption: row.dining_option,
    approvalStatus: row.approval_status,
    paymentStatus: row.payment_status,
    openedAt: iso(row.opened_at),
    closedAt: iso(row.closed_at),
    paidAt: iso(row.paid_at),
    sourceCreatedAt: iso(row.created_at_source),
    sourceModifiedAt: iso(row.modified_at_source),
    promisedAt: iso(row.promised_at),
    estimatedFulfillmentAt: iso(row.estimated_fulfillment_at),
    paymentBusinessDates: (row.payment_business_dates || []).map(dateOnly),
    fulfillmentBusinessDate: dateOnly(row.fulfillment_business_date),
    guestCount: row.guest_count,
    checkCount: row.check_count,
    itemCount: numberValue(row.item_count),
    grossSales: numberValue(row.gross_sales),
    netSales: numberValue(row.net_sales),
    discounts: numberValue(row.discounts),
    tax: numberValue(row.tax),
    serviceCharges: numberValue(row.service_charges),
    tips: numberValue(row.tips),
    refunds: numberValue(row.refunds),
    tendered: numberValue(row.tendered),
    total: numberValue(row.total),
    cashTender: numberValue(row.cash_tender),
    cardTender: numberValue(row.card_tender),
    otherTender: numberValue(row.other_tender),
    voided: row.voided,
    deleted: row.deleted,
    ...(row.details ? { details: row.details } : {}),
  }
}

const ORDER_SELECT = `
  o.order_guid, o.restaurant_guid, l.restaurant_name, o.business_date,
  o.display_number, o.source, o.dining_option, o.approval_status, o.payment_status,
  o.opened_at, o.closed_at, o.paid_at, o.created_at_source, o.modified_at_source,
  o.promised_at, o.estimated_fulfillment_at, o.payment_business_dates,
  o.fulfillment_business_date, o.guest_count, o.check_count, o.item_count::text,
  o.gross_sales::text, o.net_sales::text, o.discounts::text, o.tax::text,
  o.service_charges::text, o.tips::text, o.refunds::text, o.tendered::text,
  o.total::text, o.cash_tender::text, o.card_tender::text, o.other_tender::text,
  o.voided, o.deleted`

export async function readPosWorkspaceFromPostgres(input: {
  organizationId: string
  from: string
  to: string
  restaurantGuid: string | null
  page: number
  pageSize: number
  selectedOrderGuid: string | null
  search: string
}) {
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize)))
  const location = input.restaurantGuid || null
  const search = input.search.trim().slice(0, 160)
  const params = [input.organizationId, input.from, input.to, location]
  const [
    integration,
    locationResult,
    summaryResult,
    dailyResult,
    orderCountResult,
    orderResult,
    selectedResult,
    draftResult,
    issueResult,
    syncIssueResult,
  ] = await Promise.all([
    readToastIntegrationStateFromPostgres(input.organizationId),
    query<{
      restaurant_guid: string; restaurant_name: string; location_name: string | null
      timezone: string | null; selected: boolean; standard_access: boolean; analytics_access: boolean
    }>(
      `SELECT restaurant_guid::text, restaurant_name, location_name, timezone,
         selected, standard_access, analytics_access
       FROM toast_locations
       WHERE organization_id = $1::uuid AND active = true AND archived = false
       ORDER BY selected DESC, restaurant_name`,
      [input.organizationId],
    ),
    query<{
      business_days: string; locations: string; order_count: string; guest_count: string; check_count: string
      item_count: string; gross_sales: string; net_sales: string; discounts: string; voids: string
      refunds: string; tax: string; tips: string; service_charges: string; tendered: string
      total: string; cash: string; card: string; other_tender: string; preorder_count: string
    }>(
      `SELECT count(DISTINCT business_date) FILTER (WHERE voided = false)::text AS business_days,
         count(DISTINCT restaurant_guid) FILTER (WHERE voided = false)::text AS locations,
         count(*) FILTER (WHERE voided = false)::text AS order_count,
         coalesce(sum(guest_count) FILTER (WHERE voided = false), 0)::text AS guest_count,
         coalesce(sum(check_count) FILTER (WHERE voided = false), 0)::text AS check_count,
         coalesce(sum(item_count) FILTER (WHERE voided = false), 0)::text AS item_count,
         coalesce(sum(gross_sales) FILTER (WHERE voided = false), 0)::text AS gross_sales,
         coalesce(sum(net_sales) FILTER (WHERE voided = false), 0)::text AS net_sales,
         coalesce(sum(discounts) FILTER (WHERE voided = false), 0)::text AS discounts,
         coalesce(sum(CASE WHEN voided THEN net_sales ELSE 0 END), 0)::text AS voids,
         coalesce(sum(refunds) FILTER (WHERE voided = false), 0)::text AS refunds,
         coalesce(sum(tax) FILTER (WHERE voided = false), 0)::text AS tax,
         coalesce(sum(tips) FILTER (WHERE voided = false), 0)::text AS tips,
         coalesce(sum(service_charges) FILTER (WHERE voided = false), 0)::text AS service_charges,
         coalesce(sum(tendered) FILTER (WHERE voided = false), 0)::text AS tendered,
         coalesce(sum(total) FILTER (WHERE voided = false), 0)::text AS total,
         coalesce(sum(cash_tender) FILTER (WHERE voided = false), 0)::text AS cash,
         coalesce(sum(card_tender) FILTER (WHERE voided = false), 0)::text AS card,
         coalesce(sum(other_tender) FILTER (WHERE voided = false), 0)::text AS other_tender,
         (
           SELECT count(*)::text
           FROM toast_pos_orders preorder
           WHERE preorder.organization_id = $1::uuid
             AND ($4::uuid IS NULL OR preorder.restaurant_guid = $4::uuid)
             AND preorder.deleted = false AND preorder.voided = false
             AND EXISTS (
               SELECT 1 FROM unnest(preorder.payment_business_dates) AS payment_date
               WHERE payment_date BETWEEN $2::date AND $3::date
                 AND payment_date <> preorder.fulfillment_business_date
             )
         ) AS preorder_count
       FROM toast_pos_orders
       WHERE organization_id = $1::uuid AND business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR restaurant_guid = $4::uuid) AND deleted = false`,
      params,
    ),
    query<{
      business_date: TimestampValue; restaurant_guid: string; restaurant_name: string
      order_count: number; gross_sales: string; net_sales: string; tax: string; tips: string
      discounts: string; service_charges: string; tendered: string; total: string
    }>(
      `SELECT d.business_date, d.restaurant_guid::text, l.restaurant_name,
         d.standard_orders_count AS order_count, d.standard_gross_sales::text AS gross_sales,
         d.standard_net_sales::text AS net_sales, d.standard_tax::text AS tax,
         d.standard_tips::text AS tips, d.standard_discounts::text AS discounts,
         d.standard_service_charges::text AS service_charges,
         d.standard_tendered::text AS tendered, d.standard_total::text AS total
       FROM toast_daily_sales d
       JOIN toast_locations l ON l.organization_id = d.organization_id AND l.restaurant_guid = d.restaurant_guid
       WHERE d.organization_id = $1::uuid AND d.business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR d.restaurant_guid = $4::uuid)
       ORDER BY d.business_date, l.restaurant_name`,
      params,
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM toast_pos_orders o
       WHERE o.organization_id = $1::uuid
         AND (
           o.business_date BETWEEN $2::date AND $3::date
           OR o.fulfillment_business_date BETWEEN $2::date AND $3::date
           OR EXISTS (
             SELECT 1 FROM unnest(o.payment_business_dates) AS payment_date
             WHERE payment_date BETWEEN $2::date AND $3::date
           )
         )
         AND ($4::uuid IS NULL OR o.restaurant_guid = $4::uuid) AND o.deleted = false
         AND ($5 = '' OR o.display_number ILIKE '%' || $5 || '%' OR o.order_guid ILIKE '%' || $5 || '%')`,
      [...params, search],
    ),
    query<PosOrderRow>(
      `SELECT ${ORDER_SELECT}
       FROM toast_pos_orders o
       JOIN toast_locations l ON l.organization_id = o.organization_id AND l.restaurant_guid = o.restaurant_guid
       WHERE o.organization_id = $1::uuid
         AND (
           o.business_date BETWEEN $2::date AND $3::date
           OR o.fulfillment_business_date BETWEEN $2::date AND $3::date
           OR EXISTS (
             SELECT 1 FROM unnest(o.payment_business_dates) AS payment_date
             WHERE payment_date BETWEEN $2::date AND $3::date
           )
         )
         AND ($4::uuid IS NULL OR o.restaurant_guid = $4::uuid) AND o.deleted = false
         AND ($5 = '' OR o.display_number ILIKE '%' || $5 || '%' OR o.order_guid ILIKE '%' || $5 || '%')
       ORDER BY coalesce(o.opened_at, o.created_at) DESC, o.order_guid
       LIMIT $6 OFFSET $7`,
      [...params, search, pageSize, (page - 1) * pageSize],
    ),
    input.selectedOrderGuid
      ? query<PosOrderRow>(
          `SELECT ${ORDER_SELECT}, o.details
           FROM toast_pos_orders o
           JOIN toast_locations l ON l.organization_id = o.organization_id AND l.restaurant_guid = o.restaurant_guid
           WHERE o.organization_id = $1::uuid AND o.order_guid = $2
             AND o.deleted = false
             AND ($3::uuid IS NULL OR o.restaurant_guid = $3::uuid)
           LIMIT 1`,
          [input.organizationId, input.selectedOrderGuid, location],
        )
      : Promise.resolve({ rows: [], rowCount: 0 }),
    query<{
      id: string; restaurant_guid: string; restaurant_name: string; business_date: TimestampValue
      status: string; reconciliation_status: string; source_summary: Record<string, unknown>
      draft_revision: number; generation_reason: string; source_revision: number; updated_at: TimestampValue
      last_error: string | null; review_outcome: string | null; posting_origin: string | null
      external_posting_provider: string | null; external_posting_reference: string | null
      approved_at: TimestampValue | null; reviewed_at: TimestampValue | null; posted_at: TimestampValue | null
    }>(
      `SELECT d.id::text, d.restaurant_guid::text, l.restaurant_name, d.business_date,
         d.status, d.reconciliation_status, d.source_summary, d.draft_revision,
         d.generation_reason, d.source_revision, d.last_error, d.review_outcome,
         d.posting_origin, d.external_posting_provider, d.external_posting_reference,
         d.approved_at, d.reviewed_at, d.posted_at, d.updated_at
       FROM toast_accounting_export_drafts d
       JOIN toast_locations l ON l.organization_id = d.organization_id AND l.restaurant_guid = d.restaurant_guid
       WHERE d.organization_id = $1::uuid AND d.business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR d.restaurant_guid = $4::uuid) AND d.is_current
       ORDER BY d.business_date DESC, d.updated_at DESC`,
      params,
    ),
    query<{
      id: string; restaurant_guid: string; restaurant_name: string; business_date: TimestampValue
      status: string; issues: Array<Record<string, unknown>>; occurrence: number
      notification_count: number; opened_at: TimestampValue; last_seen_at: TimestampValue
      resolved_at: TimestampValue | null
    }>(
      `SELECT issue.id::text, issue.restaurant_guid::text, location.restaurant_name,
         issue.business_date, issue.status, issue.issues, issue.occurrence,
         issue.notification_count, issue.opened_at, issue.last_seen_at, issue.resolved_at
       FROM pos_accounting_issue_states issue
       JOIN toast_locations location
         ON location.organization_id = issue.organization_id
        AND location.restaurant_guid = issue.restaurant_guid
       WHERE issue.organization_id = $1::uuid
         AND issue.business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR issue.restaurant_guid = $4::uuid)
         AND issue.status = 'open'
       ORDER BY issue.business_date DESC, issue.last_seen_at DESC`,
      params,
    ),
    query<{
      id: string; restaurant_guid: string; restaurant_name: string; business_date: TimestampValue
      sync_kind: string; status: string; attempt_count: number; max_attempts: number
      last_error: string | null; updated_at: TimestampValue
    }>(
      `WITH configured_sources AS (
         SELECT location.organization_id, location.restaurant_guid, location.restaurant_name,
           credential.updated_at::date AS configured_on,
           CASE credential.access_type
             WHEN 'analytics' THEN 'analytics_sales'
             ELSE 'standard_orders'
           END AS sync_kind
         FROM toast_locations location
         JOIN organization_toast_credentials credential
           ON credential.organization_id = location.organization_id
          AND credential.sync_enabled = true
         WHERE location.organization_id = $1::uuid
           AND location.selected = true
           AND location.active = true
           AND location.archived = false
           AND ($4::uuid IS NULL OR location.restaurant_guid = $4::uuid)
           AND (
             (credential.access_type = 'analytics' AND location.analytics_access = true)
             OR (credential.access_type = 'standard' AND location.standard_access = true)
           )
       ), source_windows AS (
         SELECT source.organization_id, source.restaurant_guid, source.restaurant_name,
           source.sync_kind, coalesce(min(job.business_date), source.configured_on) AS first_business_date
         FROM configured_sources source
         LEFT JOIN toast_sync_outbox job
           ON job.organization_id = source.organization_id
          AND job.restaurant_guid = source.restaurant_guid
          AND job.sync_kind = source.sync_kind
         GROUP BY source.organization_id, source.restaurant_guid, source.restaurant_name,
           source.sync_kind, source.configured_on
       ), missing_source_dates AS (
         SELECT source.organization_id, source.restaurant_guid, source.restaurant_name,
           source.sync_kind, gap.business_date::date AS business_date
         FROM source_windows source
         CROSS JOIN LATERAL generate_series(
           greatest($2::date, source.first_business_date),
           least($3::date, current_date - 1),
           interval '1 day'
         ) AS gap(business_date)
         WHERE source.first_business_date IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM toast_sync_outbox existing
             WHERE existing.organization_id = source.organization_id
               AND existing.restaurant_guid = source.restaurant_guid
               AND existing.sync_kind = source.sync_kind
               AND existing.business_date = gap.business_date::date
           )
       )
       SELECT job.id::text, job.restaurant_guid::text, location.restaurant_name,
         job.business_date, job.sync_kind,
         CASE
           WHEN job.postprocess_token IS NOT NULL THEN 'stale'
           WHEN job.status IN ('processing', 'pending') THEN 'stale'
           ELSE job.status
         END AS status,
         job.attempt_count, job.max_attempts,
         coalesce(
           job.last_error,
           CASE
             WHEN job.postprocess_token IS NOT NULL
               THEN 'Toast synchronization completed, but its accounting refresh is overdue.'
             WHEN job.status = 'processing' THEN 'Toast synchronization exceeded its worker lease.'
             ELSE 'Toast synchronization is overdue and has not been claimed by a worker.'
           END
         ) AS last_error,
         job.updated_at
       FROM toast_sync_outbox job
       JOIN toast_locations location
         ON location.organization_id = job.organization_id
        AND location.restaurant_guid = job.restaurant_guid
       WHERE job.organization_id = $1::uuid
         AND job.business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR job.restaurant_guid = $4::uuid)
         AND (
           job.status IN ('failed', 'dead')
           OR (
             job.postprocess_token IS NOT NULL
             AND coalesce(job.postprocess_started_at, job.updated_at) < now() - interval '15 minutes'
           )
           OR (
             job.status = 'processing'
             AND coalesce(job.locked_at, job.updated_at) < now() - interval '15 minutes'
           )
           OR (
             job.status = 'pending'
             AND job.available_at < now() - interval '15 minutes'
           )
         )
       UNION ALL
       SELECT
         'missing:' || missing.restaurant_guid::text || ':' || missing.sync_kind || ':' || missing.business_date::text,
         missing.restaurant_guid::text,
         missing.restaurant_name,
         missing.business_date,
         missing.sync_kind,
         'missing',
         0,
         8,
         'No Toast synchronization was queued for this configured source and business date.',
         missing.business_date::timestamp
       FROM missing_source_dates missing
       ORDER BY business_date DESC, updated_at DESC`,
      params,
    ),
  ])
  const summary = summaryResult.rows[0]
  return {
    organizationId: input.organizationId,
    range: { from: input.from, to: input.to },
    locations: locationResult.rows.map((row) => ({
      restaurantGuid: row.restaurant_guid,
      restaurantName: row.restaurant_name,
      locationName: row.location_name,
      timezone: row.timezone,
      selected: row.selected,
      standardAccess: row.standard_access,
      analyticsAccess: row.analytics_access,
    })),
    summary: {
      businessDays: numberValue(summary?.business_days),
      locations: numberValue(summary?.locations),
      orderCount: numberValue(summary?.order_count),
      guestCount: numberValue(summary?.guest_count),
      checkCount: numberValue(summary?.check_count),
      itemCount: numberValue(summary?.item_count),
      grossSales: numberValue(summary?.gross_sales),
      netSales: numberValue(summary?.net_sales),
      discounts: numberValue(summary?.discounts),
      voids: numberValue(summary?.voids),
      refunds: numberValue(summary?.refunds),
      tax: numberValue(summary?.tax),
      tips: numberValue(summary?.tips),
      serviceCharges: numberValue(summary?.service_charges),
      tendered: numberValue(summary?.tendered),
      total: numberValue(summary?.total),
      cashTender: numberValue(summary?.cash),
      cardTender: numberValue(summary?.card),
      otherTender: numberValue(summary?.other_tender),
      preorderCount: numberValue(summary?.preorder_count),
    },
    daily: dailyResult.rows.map((row) => ({
      businessDate: dateOnly(row.business_date),
      restaurantGuid: row.restaurant_guid,
      restaurantName: row.restaurant_name,
      orderCount: row.order_count,
      grossSales: numberValue(row.gross_sales),
      netSales: numberValue(row.net_sales),
      tax: numberValue(row.tax),
      tips: numberValue(row.tips),
      discounts: numberValue(row.discounts),
      serviceCharges: numberValue(row.service_charges),
      tendered: numberValue(row.tendered),
      total: numberValue(row.total),
    })),
    orders: {
      items: orderResult.rows.map(posOrder),
      total: numberValue(orderCountResult.rows[0]?.count),
      page,
      pageSize,
    },
    selectedOrder: selectedResult.rows[0] ? posOrder(selectedResult.rows[0]) : null,
    drafts: draftResult.rows.map((row) => ({
      id: row.id,
      restaurantGuid: row.restaurant_guid,
      restaurantName: row.restaurant_name,
      businessDate: dateOnly(row.business_date),
      status: row.status,
      reconciliationStatus: row.reconciliation_status,
      sourceSummary: row.source_summary,
      draftRevision: row.draft_revision,
      generationReason: row.generation_reason,
      sourceRevision: row.source_revision,
      lastError: row.last_error,
      reviewOutcome: row.review_outcome,
      postingOrigin: row.posting_origin,
      externalPostingProvider: row.external_posting_provider,
      externalPostingReference: row.external_posting_reference,
      approvedAt: iso(row.approved_at),
      reviewedAt: iso(row.reviewed_at),
      postedAt: iso(row.posted_at),
      updatedAt: iso(row.updated_at),
    })),
    accountingIssues: issueResult.rows.map((row) => ({
      id: row.id,
      restaurantGuid: row.restaurant_guid,
      restaurantName: row.restaurant_name,
      businessDate: dateOnly(row.business_date),
      status: row.status,
      issues: row.issues,
      occurrence: row.occurrence,
      notificationCount: row.notification_count,
      openedAt: iso(row.opened_at),
      lastSeenAt: iso(row.last_seen_at),
      resolvedAt: iso(row.resolved_at),
    })),
    syncIssues: syncIssueResult.rows.map((row) => ({
      id: row.id,
      restaurantGuid: row.restaurant_guid,
      restaurantName: row.restaurant_name,
      businessDate: dateOnly(row.business_date),
      syncKind: row.sync_kind,
      status: row.status,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      updatedAt: iso(row.updated_at),
    })),
    readiness: {
      standardConfigured: integration.credentials.standard.configured,
      analyticsConfigured: integration.credentials.analytics.configured,
      selectedLocations: integration.locations.filter((entry) => entry.selected).length,
      latestSyncAt: integration.latestSyncAt,
      jobs: integration.jobs,
      datasets: integration.reporting.datasets,
      noDataReason: integration.reporting.noDataReason,
    },
  }
}
