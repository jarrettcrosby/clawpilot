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
  o.opened_at, o.closed_at, o.paid_at, o.guest_count, o.check_count, o.item_count::text,
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
  const [integration, locationResult, summaryResult, dailyResult, orderCountResult, orderResult, selectedResult, draftResult] = await Promise.all([
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
      total: string; cash: string; card: string; other_tender: string
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
         coalesce(sum(other_tender) FILTER (WHERE voided = false), 0)::text AS other_tender
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
       WHERE o.organization_id = $1::uuid AND o.business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR o.restaurant_guid = $4::uuid) AND o.deleted = false
         AND ($5 = '' OR o.display_number ILIKE '%' || $5 || '%' OR o.order_guid ILIKE '%' || $5 || '%')`,
      [...params, search],
    ),
    query<PosOrderRow>(
      `SELECT ${ORDER_SELECT}
       FROM toast_pos_orders o
       JOIN toast_locations l ON l.organization_id = o.organization_id AND l.restaurant_guid = o.restaurant_guid
       WHERE o.organization_id = $1::uuid AND o.business_date BETWEEN $2::date AND $3::date
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
      status: string; reconciliation_status: string; source_summary: Record<string, unknown>; updated_at: TimestampValue
    }>(
      `SELECT d.id::text, d.restaurant_guid::text, l.restaurant_name, d.business_date,
         d.status, d.reconciliation_status, d.source_summary, d.updated_at
       FROM toast_accounting_export_drafts d
       JOIN toast_locations l ON l.organization_id = d.organization_id AND l.restaurant_guid = d.restaurant_guid
       WHERE d.organization_id = $1::uuid AND d.business_date BETWEEN $2::date AND $3::date
         AND ($4::uuid IS NULL OR d.restaurant_guid = $4::uuid)
       ORDER BY d.business_date DESC, d.updated_at DESC LIMIT 50`,
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
