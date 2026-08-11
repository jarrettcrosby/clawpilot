import type { QueryResultRow } from 'pg'
import {
  WEARABLE_PICK_QUEUE_SCHEMA_VERSION,
  type WearablePickOrder,
  type WearablePickQueue,
} from '@/lib/operations/wearablePicking'
import { locationBarcode, providerBarcodeIdentity } from '@/lib/operations/barcodeLabels'
import { publicCrmProductImageUrl } from '@/lib/crm/productImagePublic'
import { query } from '@/lib/persistence/postgres'

type WearablePickRow = QueryResultRow & {
  order_global_id: string
  order_number: string
  order_row_version: string
  pick_task_global_id: string
  sequence_number: number
  product_global_id: string
  product_name: string
  channel_sku: string
  product_image_content_sha256: string | null
  barcode_snapshot: string | null
  assigned_barcode: string | null
  warehouse_global_id: string
  location_global_id: string
  location_code: string
  location_scan_required: boolean
  location_scan_policy_row_version: string
  quantity: string
}

type PickerPerformanceRow = QueryResultRow & {
  email: string
  display_name: string | null
  units_today: string
  units_seven_days: string
  orders_seven_days: string
  active_seconds_today: string
  active_seconds_seven_days: string
}

export type PickerPerformanceMetric = {
  email: string
  displayName: string | null
  unitsToday: number
  unitsSevenDays: number
  ordersSevenDays: number
  uphToday: number | null
  uphSevenDays: number | null
}

function requiredIdentity(value: string, label: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`Wearable picking ${label} is unavailable`)
  return normalized
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Wearable picking ${label} is invalid`)
  }
  return parsed
}

export async function readAssignedWearablePickQueueFromPostgres(input: {
  organizationId: string
  workerEmail: string
  publicOrigin: string
}): Promise<WearablePickQueue> {
  const organizationId = requiredIdentity(input.organizationId, 'organization')
  const workerEmail = requiredIdentity(input.workerEmail, 'worker').toLowerCase()

  const result = await query<WearablePickRow>(
    `SELECT orders.global_id AS order_global_id,
            orders.order_number,
            orders.row_version::text AS order_row_version,
            pick.global_id AS pick_task_global_id,
            pick.sequence_number,
            product.reference_code AS product_global_id,
            product.name AS product_name,
            line.channel_sku,
            product_image.content_sha256 AS product_image_content_sha256,
            product_channel.provider_barcode AS barcode_snapshot,
            product_barcode.barcode_value AS assigned_barcode,
            warehouse.global_id AS warehouse_global_id,
            location.global_id AS location_global_id,
            location.code AS location_code,
            COALESCE(scan_policy.location_scan_required, false) AS location_scan_required,
            COALESCE(scan_policy.row_version, 0)::text AS location_scan_policy_row_version,
            pick.quantity::text
     FROM operations_pick_tasks pick
     JOIN operations_fulfillment_allocations allocation
       ON allocation.organization_id = pick.organization_id
      AND allocation.id = pick.allocation_id
     JOIN operations_order_lines line
       ON line.organization_id = allocation.organization_id
      AND line.id = allocation.order_line_id
     JOIN crm_products product
       ON product.pipeline_id = line.pipeline_id
      AND product.id = line.product_id
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = pick.organization_id
      AND plan.id = pick.plan_id
     JOIN operations_orders orders
       ON orders.organization_id = plan.organization_id
      AND orders.id = plan.order_id
     LEFT JOIN LATERAL (
       SELECT channel.provider_barcode
       FROM operations_product_channel_states channel
       WHERE channel.organization_id = line.organization_id
         AND channel.integration_account_id = orders.integration_account_id
         AND channel.pipeline_id = line.pipeline_id
         AND channel.product_id = line.product_id
         AND channel.provider_sku = line.channel_sku
         AND channel.provider_active = true
         AND channel.provider_barcode IS NOT NULL
       ORDER BY channel.observed_at DESC, channel.id DESC
       LIMIT 1
     ) product_channel ON true
     LEFT JOIN operations_product_barcodes product_barcode
       ON product_barcode.organization_id = pick.organization_id
      AND product_barcode.pipeline_id = line.pipeline_id
      AND product_barcode.product_id = line.product_id
     LEFT JOIN LATERAL (
       SELECT asset.content_sha256
       FROM crm_product_image_assets asset
       WHERE asset.organization_id = pick.organization_id
         AND asset.pipeline_id = line.pipeline_id
         AND asset.product_id = line.product_id
         AND asset.is_primary = true
       ORDER BY asset.asset_revision DESC, asset.id DESC
       LIMIT 1
     ) product_image ON true
     JOIN operations_waves wave
       ON wave.organization_id = pick.organization_id
      AND wave.id = pick.wave_id
     JOIN operations_locations location
       ON location.organization_id = pick.organization_id
      AND location.id = pick.from_location_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = location.organization_id
      AND warehouse.id = location.warehouse_id
     LEFT JOIN operations_wearable_location_scan_policies scan_policy
       ON scan_policy.organization_id = warehouse.organization_id
      AND scan_policy.warehouse_id = warehouse.id
     WHERE pick.organization_id = $1::uuid
       AND lower(pick.assigned_to) = $2
       AND pick.status = 'ready'
       AND orders.status = 'released'
       AND orders.archived_at IS NULL
       AND plan.status = 'released'
       AND wave.status = 'released'
       AND warehouse.status = 'active'
       AND location.active = true
     ORDER BY orders.updated_at, orders.id, pick.sequence_number, pick.id
     LIMIT 200`,
    [organizationId, workerEmail],
  )

  const orderById = new Map<string, WearablePickOrder>()
  for (const row of result.rows) {
    const orderGlobalId = requiredIdentity(row.order_global_id, 'order')
    let order = orderById.get(orderGlobalId)
    if (!order) {
      const rowVersion = Number(row.order_row_version)
      if (!Number.isSafeInteger(rowVersion) || rowVersion < 0) {
        throw new Error('Wearable picking order version is invalid')
      }
      order = {
        orderGlobalId,
        orderNumber: requiredIdentity(row.order_number, 'order number'),
        rowVersion,
        tasks: [],
      }
      orderById.set(orderGlobalId, order)
    }
    order.tasks.push({
      pickTaskGlobalId: requiredIdentity(row.pick_task_global_id, 'task'),
      sequence: Number(row.sequence_number),
      productGlobalId: requiredIdentity(row.product_global_id, 'product'),
      productName: requiredIdentity(row.product_name, 'product name'),
      channelSku: requiredIdentity(row.channel_sku, 'SKU'),
      productImageURL: row.product_image_content_sha256 === null
        ? null
        : publicCrmProductImageUrl({
            publicOrigin: input.publicOrigin,
            productReferenceCode: row.product_global_id,
            contentSha256: row.product_image_content_sha256,
          }),
      barcode: (row.assigned_barcode === null
        ? providerBarcodeIdentity(row.barcode_snapshot)?.value || null
        : requiredIdentity(row.assigned_barcode, 'assigned barcode')),
      locationCode: requiredIdentity(row.location_code, 'location'),
      ...(row.location_scan_required ? {
        warehouseGlobalId: requiredIdentity(row.warehouse_global_id, 'warehouse identity'),
        locationGlobalId: requiredIdentity(row.location_global_id, 'location identity'),
        locationBarcode: locationBarcode(
          requiredIdentity(row.location_global_id, 'location identity'),
        ),
        locationScanRequired: true as const,
        locationScanPolicyRowVersion: positiveNumber(
          row.location_scan_policy_row_version,
          'location scan policy version',
        ),
      } : {}),
      quantity: positiveNumber(row.quantity, 'quantity'),
    })
  }

  return {
    schemaVersion: WEARABLE_PICK_QUEUE_SCHEMA_VERSION,
    organizationId,
    workerEmail,
    generatedAt: new Date().toISOString(),
    orders: [...orderById.values()],
  }
}

function uph(units: number, activeSeconds: number): number | null {
  if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(activeSeconds) || activeSeconds <= 0) {
    return null
  }
  return Math.round((units * 3600 / activeSeconds) * 10) / 10
}

export async function readPickerPerformanceFromPostgres(input: {
  organizationId: string
  pickerEmail?: string | null
}): Promise<PickerPerformanceMetric[]> {
  const organizationId = requiredIdentity(input.organizationId, 'organization')
  const pickerEmail = String(input.pickerEmail || '').trim().toLowerCase() || null
  const result = await query<PickerPerformanceRow>(
    `WITH completed_orders AS (
       SELECT lower(pick.assigned_to) AS email,
              plan.order_id,
              sum(pick.picked_quantity)::numeric AS units,
              min(COALESCE(pick.assigned_at, pick.created_at)) AS assigned_at,
              max(pick.picked_at) AS completed_at
       FROM operations_pick_tasks pick
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = pick.organization_id
        AND plan.id = pick.plan_id
       WHERE pick.organization_id = $1::uuid
         AND pick.status = 'picked'
         AND pick.assigned_to IS NOT NULL
         AND pick.picked_quantity IS NOT NULL
         AND pick.picked_at >= now() - interval '7 days'
         AND ($2::text IS NULL OR lower(pick.assigned_to) = $2)
       GROUP BY lower(pick.assigned_to), plan.order_id
     ), picker_totals AS (
       SELECT email,
              COALESCE(sum(units) FILTER (
                WHERE completed_at >= date_trunc('day', now())
              ), 0)::text AS units_today,
              COALESCE(sum(units), 0)::text AS units_seven_days,
              count(*)::text AS orders_seven_days,
              COALESCE(sum(GREATEST(
                EXTRACT(epoch FROM completed_at - assigned_at), 60
              )) FILTER (
                WHERE completed_at >= date_trunc('day', now())
              ), 0)::text AS active_seconds_today,
              COALESCE(sum(GREATEST(
                EXTRACT(epoch FROM completed_at - assigned_at), 60
              )), 0)::text AS active_seconds_seven_days
       FROM completed_orders
       GROUP BY email
     )
     SELECT totals.email,
            app_user.display_name,
            totals.units_today,
            totals.units_seven_days,
            totals.orders_seven_days,
            totals.active_seconds_today,
            totals.active_seconds_seven_days
     FROM picker_totals totals
     JOIN app_users app_user ON lower(app_user.email) = totals.email
     ORDER BY (totals.units_seven_days::numeric * 3600
               / NULLIF(totals.active_seconds_seven_days::numeric, 0)) DESC NULLS LAST,
              lower(COALESCE(app_user.display_name, totals.email))`,
    [organizationId, pickerEmail],
  )

  return result.rows.map((row) => {
    const unitsToday = Number(row.units_today)
    const unitsSevenDays = Number(row.units_seven_days)
    const activeSecondsToday = Number(row.active_seconds_today)
    const activeSecondsSevenDays = Number(row.active_seconds_seven_days)
    return {
      email: row.email,
      displayName: row.display_name,
      unitsToday,
      unitsSevenDays,
      ordersSevenDays: Number(row.orders_seven_days),
      uphToday: uph(unitsToday, activeSecondsToday),
      uphSevenDays: uph(unitsSevenDays, activeSecondsSevenDays),
    }
  })
}
