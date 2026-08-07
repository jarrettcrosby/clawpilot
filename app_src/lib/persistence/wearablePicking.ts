import type { QueryResultRow } from 'pg'
import {
  WEARABLE_PICK_QUEUE_SCHEMA_VERSION,
  type WearablePickOrder,
  type WearablePickQueue,
} from '@/lib/operations/wearablePicking'
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
  barcode_snapshot: string | null
  location_code: string
  quantity: string
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
            line.barcode_snapshot,
            location.code AS location_code,
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
     JOIN operations_waves wave
       ON wave.organization_id = pick.organization_id
      AND wave.id = pick.wave_id
     JOIN operations_locations location
       ON location.organization_id = pick.organization_id
      AND location.id = pick.from_location_id
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = location.organization_id
      AND warehouse.id = location.warehouse_id
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
      barcode: row.barcode_snapshot === null
        ? null
        : requiredIdentity(row.barcode_snapshot, 'barcode'),
      locationCode: requiredIdentity(row.location_code, 'location'),
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

