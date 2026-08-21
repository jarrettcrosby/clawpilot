import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'

import { recordAuditEvent } from '@/lib/auditWriter'
import {
  oneOffShipmentHash,
  type OneOffShippingPackCommandResult,
  type OneOffShippingPackReview,
} from '@/lib/operations/oneOffShipments'
import { ONE_OFF_PACK_CONFIRMATION } from '@/lib/operations/oneOffShipmentConstants'
import { OneOffShipmentPersistenceError } from '@/lib/persistence/oneOffShipments'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type JsonObject = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/

type PackContextRow = QueryResultRow & {
  order_id: string
  order_global_id: string
  order_status: string
  order_row_version: string
  source_provider: string
  order_type: string
  plan_id: string
  plan_global_id: string
  plan_status: string
  plan_version_number: number
  quote_id: string
  quote_global_id: string
  offer_id: string
  offer_global_id: string
  execution_mode: 'test' | 'live'
  lines_snapshot: JsonObject[]
  packages_snapshot: JsonObject[]
  exact_execution: boolean
  exact_package_set: boolean
  pick_task_count: string
  carrier_group_count: string
  label_count: string
  shipment_count: string
}

type CurrentLineRow = QueryResultRow & {
  line_key: string
  product_global_id: string
  product_name: string
  sku: string | null
  quantity: string
  unit_price_minor: string
  weight_grams: number
  dimensions_mm: JsonObject
}

type AdHocLineRow = QueryResultRow & {
  line_key: string
  quantity: string
  item_snapshot: JsonObject
}

type PackageRow = QueryResultRow & {
  id: string
  global_id: string
  package_number: number
  status: 'planned' | 'packed' | 'labeled' | 'shipped'
  length_mm: number
  width_mm: number
  height_mm: number
  weight_grams: number
  contents: Array<{ lineKey: string; quantity: number }>
}

type ReservationRow = QueryResultRow & {
  global_id: string
  line_key: string
  product_global_id: string
  position_global_id: string
  position_version: string
  quantity: string
  allocation_quantity: string
  status: 'active' | 'released' | 'consumed'
  on_hand_quantity: string
  reserved_quantity: string
  damaged_quantity: string
}

type PackReceiptRow = QueryResultRow & {
  id: string
  idempotency_key: string
  request_hash: string
  order_global_id: string
  plan_global_id: string
  order_row_version_after: string
  review_snapshot_hash: string
  package_count: number
  reservation_count: number
  packed_at: Date
}

type PackEvidence = {
  context: PackContextRow
  snapshot: {
    schemaVersion: 'shipping.one_off_pack_review.v1'
    order: {
      globalId: string
      status: string
      rowVersion: number
      sourceProvider: string
      orderType: string
    }
    plan: {
      globalId: string
      status: string
      versionNumber: number
      quoteGlobalId: string
      offerGlobalId: string
      executionMode: 'test' | 'live'
    }
    lines: OneOffShippingPackReview['lines']
    packages: OneOffShippingPackReview['packages']
    reservations: OneOffShippingPackReview['reservations']
  }
  hash: string
  blocker: string | null
  pureAdHoc: boolean
}

function fail(code: string, message: string, status = 409): never {
  throw new OneOffShipmentPersistenceError(code, message, status)
}

function requiredOrganizationId(value: unknown) {
  const normalized = String(value ?? '').trim()
  if (!UUID.test(normalized)) {
    fail('OPERATIONS_ONE_OFF_GROUP_REQUEST_INVALID', 'Organization is invalid', 400)
  }
  return normalized
}

function requiredOrderGlobalId(value: unknown) {
  const normalized = String(value ?? '').trim()
  if (!ORDER_GLOBAL_ID.test(normalized)) {
    fail('OPERATIONS_ONE_OFF_GROUP_REQUEST_INVALID', 'Order is invalid', 400)
  }
  return normalized
}

function requiredVersion(value: unknown) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail('OPERATIONS_ONE_OFF_GROUP_REQUEST_INVALID', 'Order version is invalid', 400)
  }
  return parsed
}

function requiredHash(value: unknown) {
  const normalized = String(value ?? '').trim()
  if (!HASH.test(normalized)) {
    fail(
      'OPERATIONS_ONE_OFF_PACK_REVIEW_INVALID',
      'Refresh and review the exact current package evidence before packing',
      400,
    )
  }
  return normalized
}

function requiredIdempotencyKey(value: unknown) {
  const normalized = String(value ?? '').trim()
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    fail(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A stable Idempotency-Key is required',
      400,
    )
  }
  return normalized
}

function requiredReason(value: unknown) {
  const normalized = String(value ?? '').trim()
  if (
    normalized.length < 10
    || normalized.length > 500
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      'OPERATIONS_ONE_OFF_PACK_REASON_INVALID',
      'A physical pack confirmation reason of 10-500 characters is required',
      400,
    )
  }
  return normalized
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    fail(
      'OPERATIONS_ONE_OFF_PACK_EVIDENCE_INVALID',
      'Stored one-off pack evidence contains an invalid number',
      500,
    )
  }
  return parsed
}

async function dbQuery<T extends QueryResultRow>(
  client: PoolClient | null,
  sql: string,
  values: unknown[],
) {
  return client ? client.query<T>(sql, values) : query<T>(sql, values)
}

async function readContext(
  organizationId: string,
  orderGlobalId: string,
  client: PoolClient | null,
  lock: boolean,
) {
  const result = await dbQuery<PackContextRow>(
    client,
    `SELECT source_order.id::text AS order_id,
            source_order.global_id AS order_global_id,
            source_order.status AS order_status,
            source_order.row_version::text AS order_row_version,
            source_order.source_provider, source_order.order_type,
            plan.id::text AS plan_id, plan.global_id AS plan_global_id,
            plan.status AS plan_status,
            plan.version_number AS plan_version_number,
            quote.id::text AS quote_id, quote.global_id AS quote_global_id,
            offer.id::text AS offer_id, offer.global_id AS offer_global_id,
            quote.execution_mode, quote.lines_snapshot,
            quote.packages_snapshot,
            operations_one_off_plan_execution_is_exact(
              plan.organization_id, plan.id, quote.execution_mode
            ) AS exact_execution,
            operations_one_off_plan_package_set_is_exact(
              plan.organization_id, plan.id, quote.id
            ) AS exact_package_set,
            (SELECT count(*)
             FROM operations_pick_tasks pick
             WHERE pick.organization_id = plan.organization_id
               AND pick.plan_id = plan.id)::text AS pick_task_count,
            (SELECT count(*)
             FROM operations_one_off_carrier_group_attempts attempt
             WHERE attempt.organization_id = plan.organization_id
               AND attempt.order_id = source_order.id
               AND attempt.plan_id = plan.id)::text AS carrier_group_count,
            (SELECT count(*)
             FROM operations_labels label
             JOIN operations_packages package
               ON package.organization_id = label.organization_id
              AND package.id = label.package_id
             WHERE package.organization_id = plan.organization_id
               AND package.plan_id = plan.id)::text AS label_count,
            (SELECT count(*)
             FROM operations_shipments shipment
             WHERE shipment.organization_id = plan.organization_id
               AND shipment.order_id = source_order.id
               AND shipment.plan_id = plan.id)::text AS shipment_count
     FROM operations_orders source_order
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = source_order.organization_id
      AND plan.order_id = source_order.id
      AND plan.id = (
        SELECT candidate.id
        FROM operations_fulfillment_plans candidate
        WHERE candidate.organization_id = source_order.organization_id
          AND candidate.order_id = source_order.id
        ORDER BY candidate.version_number DESC, candidate.created_at DESC,
                 candidate.id DESC
        LIMIT 1
      )
     JOIN operations_one_off_shipment_quotes quote
       ON quote.organization_id = plan.organization_id
      AND quote.id = plan.one_off_quote_id
     JOIN operations_one_off_shipment_quote_offers offer
       ON offer.organization_id = plan.organization_id
      AND offer.quote_id = plan.one_off_quote_id
      AND offer.id = plan.one_off_offer_id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
       AND source_order.source_provider = 'clawpilot_native'
       AND source_order.order_type = 'one_off'
       AND source_order.archived_at IS NULL
     LIMIT 1
     ${lock
      ? 'FOR UPDATE OF source_order, plan FOR SHARE OF quote, offer'
      : ''}`,
    [organizationId, orderGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'OPERATIONS_ONE_OFF_PACK_CONTEXT_UNAVAILABLE',
      'The exact ClawPilot-native one-off order and current plan were not found in this organization',
      404,
    )
  }
  return row
}

async function readCurrentLines(
  organizationId: string,
  orderId: string,
  client: PoolClient | null,
  lock: boolean,
) {
  const canonical = await dbQuery<CurrentLineRow>(
    client,
    `SELECT line.external_line_id AS line_key,
            product.reference_code AS product_global_id,
            product.name AS product_name,
            NULLIF(btrim(product.sku), '') AS sku,
            line.quantity::text, line.unit_price_minor::text,
            line.weight_grams, line.dimensions_mm
     FROM operations_order_lines line
     JOIN crm_products product
       ON product.pipeline_id = line.pipeline_id
      AND product.id = line.product_id
     WHERE line.organization_id = $1::uuid
       AND line.order_id = $2::uuid
       AND line.revision_retired_at IS NULL
     ORDER BY line.external_line_id, line.id
     ${lock ? 'FOR SHARE OF line, product' : ''}`,
    [organizationId, orderId],
  )
  const adHoc = await dbQuery<AdHocLineRow>(
    client,
    `SELECT line_key, quantity::text, item_snapshot
     FROM operations_one_off_ad_hoc_order_lines line
     WHERE line.organization_id = $1::uuid AND line.order_id = $2::uuid
     ORDER BY line.line_key, line.id
     ${lock ? 'FOR SHARE OF line' : ''}`,
    [organizationId, orderId],
  )
  return { canonical: canonical.rows, adHoc: adHoc.rows }
}

async function readPackages(
  organizationId: string,
  context: PackContextRow,
  client: PoolClient | null,
  lock: boolean,
) {
  if (lock) {
    await dbQuery(
      client,
      `SELECT content.id
       FROM operations_package_contents content
       WHERE content.organization_id = $1::uuid
         AND content.plan_id = $2::uuid
       ORDER BY content.id
       FOR SHARE OF content`,
      [organizationId, context.plan_id],
    )
    await dbQuery(
      client,
      `SELECT content.id
       FROM operations_one_off_ad_hoc_package_contents content
       WHERE content.organization_id = $1::uuid
         AND content.plan_id = $2::uuid
       ORDER BY content.id
       FOR SHARE OF content`,
      [organizationId, context.plan_id],
    )
  }
  const result = await dbQuery<PackageRow>(
    client,
    `SELECT package.id::text, package.global_id, package.package_number,
            package.status, package.length_mm, package.width_mm,
            package.height_mm, package.weight_grams,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'lineKey', package_content.line_key,
                'quantity', package_content.quantity
              ) ORDER BY package_content.line_key)
              FROM (
                SELECT order_line.external_line_id AS line_key,
                       content.quantity
                FROM operations_package_contents content
                JOIN operations_current_order_lines order_line
                  ON order_line.organization_id = content.organization_id
                 AND order_line.id = content.order_line_id
                 AND order_line.order_id = content.order_id
                WHERE content.organization_id = package.organization_id
                  AND content.plan_id = package.plan_id
                  AND content.package_id = package.id
                UNION ALL
                SELECT ad_hoc.line_key, content.quantity
                FROM operations_one_off_ad_hoc_package_contents content
                JOIN operations_one_off_ad_hoc_order_lines ad_hoc
                  ON ad_hoc.organization_id = content.organization_id
                 AND ad_hoc.order_id = content.order_id
                 AND ad_hoc.id = content.ad_hoc_order_line_id
                WHERE content.organization_id = package.organization_id
                  AND content.plan_id = package.plan_id
                  AND content.package_id = package.id
              ) package_content
            ), '[]'::jsonb) AS contents
     FROM operations_packages package
     WHERE package.organization_id = $1::uuid
       AND package.plan_id = $2::uuid
     ORDER BY package.package_number, package.id
     ${lock ? 'FOR UPDATE OF package' : ''}`,
    [organizationId, context.plan_id],
  )
  return result.rows
}

async function readReservations(
  organizationId: string,
  context: PackContextRow,
  client: PoolClient | null,
  lock: boolean,
) {
  const result = await dbQuery<ReservationRow>(
    client,
    `SELECT reservation.global_id,
            order_line.external_line_id AS line_key,
            product.reference_code AS product_global_id,
            position.global_id AS position_global_id,
            position.version::text AS position_version,
            reservation.quantity::text,
            allocation.quantity::text AS allocation_quantity,
            reservation.status,
            position.on_hand_quantity::text,
            position.reserved_quantity::text,
            position.damaged_quantity::text
     FROM operations_fulfillment_allocations allocation
     JOIN operations_reservations reservation
       ON reservation.organization_id = allocation.organization_id
      AND reservation.id = allocation.reservation_id
      AND reservation.order_line_id = allocation.order_line_id
      AND reservation.position_id = allocation.position_id
     JOIN operations_current_order_lines order_line
       ON order_line.organization_id = allocation.organization_id
      AND order_line.order_id = $3::uuid
      AND order_line.id = allocation.order_line_id
     JOIN crm_products product
       ON product.pipeline_id = order_line.pipeline_id
      AND product.id = order_line.product_id
     JOIN operations_inventory_positions position
       ON position.organization_id = allocation.organization_id
      AND position.id = allocation.position_id
     WHERE allocation.organization_id = $1::uuid
       AND allocation.plan_id = $2::uuid
     ORDER BY order_line.external_line_id, position.global_id,
              reservation.global_id
     ${lock ? 'FOR UPDATE OF allocation, reservation, position' : ''}`,
    [organizationId, context.plan_id, context.order_id],
  )
  return result.rows
}

function exactCurrentLines(
  sealedLines: JsonObject[],
  canonical: CurrentLineRow[],
  adHoc: AdHocLineRow[],
) {
  if (!Array.isArray(sealedLines) || sealedLines.length < 1) return false
  const canonicalByKey = new Map(canonical.map((line) => [line.line_key, line]))
  const adHocByKey = new Map(adHoc.map((line) => [line.line_key, line]))
  if (canonical.length + adHoc.length !== sealedLines.length) return false
  for (const sealed of sealedLines) {
    const lineKey = String(sealed.lineKey || '')
    const quantity = numberValue(sealed.quantity)
    if (sealed.kind === 'ad_hoc') {
      const current = adHocByKey.get(lineKey)
      if (
        !current
        || numberValue(current.quantity) !== quantity
        || current.item_snapshot.name !== sealed.productName
        || (String(current.item_snapshot.sku || '') || null)
          !== (String(sealed.sku || '') || null)
      ) return false
      continue
    }
    if (sealed.kind !== 'existing' && sealed.kind !== 'new') return false
    const current = canonicalByKey.get(lineKey)
    if (!current || numberValue(current.quantity) !== quantity) return false
    if (
      sealed.kind === 'existing'
      && current.product_global_id !== sealed.productGlobalId
    ) return false
    if (
      sealed.kind === 'new'
      && (
        current.product_name !== sealed.productName
        || (current.sku || '') !== String(sealed.sku || '')
        || numberValue(current.unit_price_minor)
          !== numberValue(sealed.unitPriceMinor)
        || current.weight_grams !== numberValue(sealed.unitWeightGrams)
        || current.dimensions_mm.length
          !== (sealed.unitDimensionsMm as JsonObject)?.length
        || current.dimensions_mm.width
          !== (sealed.unitDimensionsMm as JsonObject)?.width
        || current.dimensions_mm.height
          !== (sealed.unitDimensionsMm as JsonObject)?.height
      )
    ) return false
  }
  return true
}

function exactReservations(
  sealedLines: JsonObject[],
  reservations: ReservationRow[],
) {
  const expected = new Map<string, number>()
  for (const line of sealedLines) {
    if (line.kind === 'ad_hoc') continue
    expected.set(String(line.lineKey), numberValue(line.quantity))
  }
  if (expected.size < 1 || reservations.length < 1) return false
  const byLine = new Map<string, number>()
  const byPosition = new Map<string, { reserved: number; claimed: number }>()
  for (const reservation of reservations) {
    const quantity = numberValue(reservation.quantity)
    if (
      reservation.status !== 'active'
      || quantity !== numberValue(reservation.allocation_quantity)
      || numberValue(reservation.on_hand_quantity)
        - numberValue(reservation.damaged_quantity) < quantity
    ) return false
    byLine.set(
      reservation.line_key,
      (byLine.get(reservation.line_key) || 0) + quantity,
    )
    const position = byPosition.get(reservation.position_global_id) || {
      reserved: numberValue(reservation.reserved_quantity),
      claimed: 0,
    }
    position.claimed += quantity
    byPosition.set(reservation.position_global_id, position)
  }
  for (const [lineKey, quantity] of expected) {
    if (byLine.get(lineKey) !== quantity) return false
  }
  if ([...byLine.keys()].some((lineKey) => !expected.has(lineKey))) return false
  return [...byPosition.values()].every((position) => (
    position.reserved >= position.claimed
  ))
}

async function readPackEvidence(
  organizationId: string,
  orderGlobalId: string,
  client: PoolClient | null,
  lock: boolean,
): Promise<PackEvidence> {
  const context = await readContext(organizationId, orderGlobalId, client, lock)
  // Deliberate lock order: order/plan/quote -> lines -> immutable contents and
  // packages -> allocations/reservations/positions. Sequential reads keep the
  // evidence set and its concurrent-writer behavior explicit on one client.
  const currentLines = await readCurrentLines(
    organizationId,
    context.order_id,
    client,
    lock,
  )
  const packages = await readPackages(organizationId, context, client, lock)
  const reservations = await readReservations(
    organizationId,
    context,
    client,
    lock,
  )
  const orderReservationCount = await dbQuery<{ count: string }>(
    client,
    `SELECT count(*)::text AS count
     FROM operations_reservations
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [organizationId, context.order_id],
  )
  const sealedLines = context.lines_snapshot
  const pureAdHoc = sealedLines.length > 0
    && sealedLines.every((line) => line.kind === 'ad_hoc')
  const canonicalByKey = new Map(
    currentLines.canonical.map((line) => [line.line_key, line]),
  )
  const adHocByKey = new Map(
    currentLines.adHoc.map((line) => [line.line_key, line]),
  )
  const lines: OneOffShippingPackReview['lines'] = sealedLines.map((sealed) => {
    const lineKey = String(sealed.lineKey || '')
    const canonical = canonicalByKey.get(lineKey)
    const adHoc = adHocByKey.get(lineKey)
    return {
      lineKey,
      kind: sealed.kind as 'existing' | 'new' | 'ad_hoc',
      name: String(
        sealed.productName || canonical?.product_name
          || adHoc?.item_snapshot.name || '',
      ),
      sku: String(
        sealed.sku || canonical?.sku || adHoc?.item_snapshot.sku || '',
      ) || null,
      productGlobalId: canonical?.product_global_id || null,
      quantity: numberValue(sealed.quantity),
    }
  })
  const reviewedPackages: OneOffShippingPackReview['packages'] = packages.map(
    (item, index) => ({
      globalId: item.global_id,
      packageNumber: item.package_number,
      description: String(
        context.packages_snapshot[index]?.description
          || `Parcel ${item.package_number}`,
      ),
      status: item.status,
      dimensionsMm: {
        length: item.length_mm,
        width: item.width_mm,
        height: item.height_mm,
      },
      grossWeightGrams: item.weight_grams,
      contents: item.contents.map((content) => ({
        lineKey: String(content.lineKey),
        quantity: numberValue(content.quantity),
      })),
    }),
  )
  const reviewedReservations: OneOffShippingPackReview['reservations'] =
    reservations.map((reservation) => ({
      globalId: reservation.global_id,
      lineKey: reservation.line_key,
      productGlobalId: reservation.product_global_id,
      positionGlobalId: reservation.position_global_id,
      positionRowVersion: numberValue(reservation.position_version),
      quantity: numberValue(reservation.quantity),
      status: reservation.status,
    }))
  const snapshot = {
    schemaVersion: 'shipping.one_off_pack_review.v1' as const,
    order: {
      globalId: context.order_global_id,
      status: context.order_status,
      rowVersion: numberValue(context.order_row_version),
      sourceProvider: context.source_provider,
      orderType: context.order_type,
    },
    plan: {
      globalId: context.plan_global_id,
      status: context.plan_status,
      versionNumber: context.plan_version_number,
      quoteGlobalId: context.quote_global_id,
      offerGlobalId: context.offer_global_id,
      executionMode: context.execution_mode,
    },
    lines,
    packages: reviewedPackages,
    reservations: reviewedReservations,
  }
  let blocker: string | null = null
  if (!context.exact_execution || !context.exact_package_set) {
    blocker = 'The current one-off plan no longer matches its sealed carrier and package evidence.'
  } else if (!exactCurrentLines(
    sealedLines,
    currentLines.canonical,
    currentLines.adHoc,
  )) {
    blocker = 'The current item lines no longer match the sealed one-off plan.'
  } else if (
    packages.length < 1
    || packages.length > 40
    || packages.some((item, index) => item.package_number !== index + 1)
  ) {
    blocker = 'The exact contiguous package set is unavailable.'
  } else if (
    context.order_status === 'planned'
    && context.plan_status !== 'planned'
  ) {
    blocker = 'This plan has entered another fulfillment workflow and cannot be packed from Shipping.'
  } else if (
    context.order_status === 'planned'
    && packages.some((item) => item.status !== 'planned')
  ) {
    blocker = 'Every package must still be planned before one Shipping confirmation packs the set.'
  } else if (
    context.order_status === 'planned'
    && pureAdHoc
  ) {
    blocker = 'A pure ad-hoc one-off should already be packed without a physical inventory transition.'
  } else if (
    context.order_status === 'planned'
    && (
      !exactReservations(sealedLines, reservations)
      || numberValue(orderReservationCount.rows[0]?.count || 0)
        !== reservations.length
    )
  ) {
    blocker = 'The active inventory reservations no longer exactly cover every product line.'
  } else if (
    context.order_status === 'planned'
    && (
      numberValue(context.pick_task_count) > 0
      || numberValue(context.carrier_group_count) > 0
      || numberValue(context.label_count) > 0
      || numberValue(context.shipment_count) > 0
    )
  ) {
    blocker = 'This plan already has warehouse or carrier execution evidence and cannot use the Shipping-only pack transition.'
  } else if (!['planned', 'packed'].includes(context.order_status)) {
    blocker = `This one-off order cannot be reviewed from ${context.order_status}.`
  }
  return {
    context,
    snapshot,
    hash: oneOffShipmentHash(snapshot),
    blocker,
    pureAdHoc,
  }
}

async function readPackReceipt(
  organizationId: string,
  whereSql: string,
  value: string,
  client: PoolClient | null,
  lock = false,
) {
  const result = await dbQuery<PackReceiptRow>(
    client,
    `SELECT receipt.id::text, receipt.idempotency_key,
            receipt.request_hash,
            source_order.global_id AS order_global_id,
            plan.global_id AS plan_global_id,
            receipt.order_row_version_after::text,
            receipt.review_snapshot_hash, receipt.package_count,
            receipt.reservation_count, receipt.packed_at
     FROM operations_shipping_one_off_pack_receipts receipt
     JOIN operations_orders source_order
       ON source_order.organization_id = receipt.organization_id
      AND source_order.id = receipt.order_id
     JOIN operations_fulfillment_plans plan
       ON plan.organization_id = receipt.organization_id
      AND plan.id = receipt.plan_id
     WHERE receipt.organization_id = $1::uuid AND ${whereSql} = $2
     LIMIT 1
     ${lock ? 'FOR UPDATE OF receipt' : ''}`,
    [organizationId, value],
  )
  return result.rows[0] || null
}

function resultFromReceipt(
  receipt: PackReceiptRow,
  replayed: boolean,
): OneOffShippingPackCommandResult {
  return {
    orderGlobalId: receipt.order_global_id,
    orderStatus: 'packed',
    rowVersion: numberValue(receipt.order_row_version_after),
    fulfillmentPlanGlobalId: receipt.plan_global_id,
    reviewSnapshotHash: receipt.review_snapshot_hash,
    packageCount: receipt.package_count,
    reservationCount: receipt.reservation_count,
    packedAt: new Date(receipt.packed_at).toISOString(),
    effects: {
      providerWrites: 0,
      labelWrites: 0,
      shipmentWrites: 0,
      inventoryWrites: 0,
    },
    replayed,
  }
}

export async function readShippingOneOffPackReviewFromPostgres(input: {
  organizationId: string
  orderGlobalId: string
}): Promise<OneOffShippingPackReview> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const orderGlobalId = requiredOrderGlobalId(input.orderGlobalId)
  const evidence = await readPackEvidence(
    organizationId,
    orderGlobalId,
    null,
    false,
  )
  const receipt = await readPackReceipt(
    organizationId,
    'receipt.order_id',
    evidence.context.order_id,
    null,
  )
  const packed = evidence.context.order_status === 'packed'
  return {
    state: packed ? 'packed' : 'review_required',
    required: !packed && !evidence.pureAdHoc,
    evidenceHash: !packed && !evidence.blocker ? evidence.hash : null,
    blocker: evidence.blocker,
    lines: evidence.snapshot.lines,
    packages: evidence.snapshot.packages,
    reservations: evidence.snapshot.reservations,
    receipt: receipt ? {
      requestIdempotencyKey: receipt.idempotency_key,
      reviewSnapshotHash: receipt.review_snapshot_hash,
      packageCount: receipt.package_count,
      reservationCount: receipt.reservation_count,
      packedAt: new Date(receipt.packed_at).toISOString(),
    } : null,
  }
}

export async function packShippingOneOffShipmentInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  orderGlobalId: string
  expectedRowVersion: number
  expectedReviewSnapshotHash: string
  confirmation: string
  reason: string
}): Promise<OneOffShippingPackCommandResult> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const orderGlobalId = requiredOrderGlobalId(input.orderGlobalId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail) {
    fail('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  }
  const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey)
  const expectedRowVersion = requiredVersion(input.expectedRowVersion)
  const expectedReviewSnapshotHash = requiredHash(
    input.expectedReviewSnapshotHash,
  )
  const reason = requiredReason(input.reason)
  if (input.confirmation !== ONE_OFF_PACK_CONFIRMATION) {
    fail(
      'OPERATIONS_ONE_OFF_PACK_CONFIRMATION_REQUIRED',
      'Confirm that every exact reviewed item is physically in its assigned package',
      400,
    )
  }
  const requestHash = oneOffShipmentHash({
    orderGlobalId,
    expectedRowVersion,
    expectedReviewSnapshotHash,
    confirmation: ONE_OFF_PACK_CONFIRMATION,
    reason,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shipping:one-off-pack:idempotency:${organizationId}:${idempotencyKey}`,
    )
    const replay = await readPackReceipt(
      organizationId,
      'receipt.idempotency_key',
      idempotencyKey,
      client,
      true,
    )
    if (replay) {
      if (
        replay.request_hash !== requestHash
        || replay.order_global_id !== orderGlobalId
      ) {
        fail(
          'OPERATIONS_IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for different Shipping pack evidence',
        )
      }
      return resultFromReceipt(replay, true)
    }
    await acquireTransactionAdvisoryLock(
      client,
      `shipping:one-off-pack:${organizationId}:${orderGlobalId}`,
    )

    const evidence = await readPackEvidence(
      organizationId,
      orderGlobalId,
      client,
      true,
    )
    if (evidence.context.order_status !== 'planned') {
      fail(
        'OPERATIONS_ONE_OFF_PACK_STATE_INVALID',
        'This one-off shipment is not awaiting Shipping pack confirmation',
      )
    }
    if (evidence.pureAdHoc) {
      fail(
        'OPERATIONS_ONE_OFF_PACK_NOT_REQUIRED',
        'A pure ad-hoc one-off is already packed during planning and needs no inventory pack transition',
      )
    }
    if (evidence.blocker) {
      fail('OPERATIONS_ONE_OFF_PACK_EVIDENCE_STALE', evidence.blocker)
    }
    if (numberValue(evidence.context.order_row_version) !== expectedRowVersion) {
      fail(
        'OPERATIONS_ORDER_VERSION_CONFLICT',
        'The one-off order changed. Refresh and review it again before packing.',
      )
    }
    if (evidence.hash !== expectedReviewSnapshotHash) {
      fail(
        'OPERATIONS_ONE_OFF_PACK_EVIDENCE_STALE',
        'The plan, packages, contents, reservations, or row versions changed. Refresh and physically review the exact current evidence again.',
      )
    }

    const packedPackages = await client.query<{
      global_id: string
      packed_at: Date
    }>(
      `UPDATE operations_packages
       SET status = 'packed', packed_by = $3,
           packed_at = date_trunc('milliseconds', now())
       WHERE organization_id = $1::uuid AND plan_id = $2::uuid
         AND status = 'planned'
       RETURNING global_id, packed_at`,
      [organizationId, evidence.context.plan_id, actorEmail],
    )
    if (Number(packedPackages.rowCount || 0) !== evidence.snapshot.packages.length) {
      fail(
        'OPERATIONS_ONE_OFF_PACK_EVIDENCE_STALE',
        'The package set changed before it could be packed. Refresh and review it again.',
      )
    }
    const packedAt = packedPackages.rows[0]?.packed_at
    if (
      !packedAt
      || packedPackages.rows.some((item) => (
        new Date(item.packed_at).getTime() !== new Date(packedAt).getTime()
      ))
    ) {
      fail(
        'OPERATIONS_ONE_OFF_PACK_EVIDENCE_INVALID',
        'The package confirmation timestamp was not atomic',
        500,
      )
    }
    const updatedOrder = await client.query<{
      global_id: string
      row_version: string
    }>(
      `UPDATE operations_orders
       SET status = 'packed', row_version = row_version + 1,
           updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
         AND status = 'planned' AND row_version = $3
       RETURNING global_id, row_version::text`,
      [organizationId, evidence.context.order_id, expectedRowVersion, actorEmail],
    )
    if (!updatedOrder.rows[0]) {
      fail(
        'OPERATIONS_ORDER_VERSION_CONFLICT',
        'The one-off order changed before it could be packed. Refresh and review it again.',
      )
    }

    const receiptId = randomUUID()
    await client.query(
      `INSERT INTO operations_shipping_one_off_pack_receipts (
         id, organization_id, order_id, plan_id,
         planning_quote_id, planning_offer_id, actor_email,
         idempotency_key, request_hash, reason, confirmation_statement,
         expected_order_row_version, order_row_version_after,
         plan_version_number, review_snapshot, review_snapshot_hash,
         package_count, reservation_count, packed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7,
         $8, $9, $10, $11, $12, $13,
         $14, $15::jsonb, $16, $17, $18, $19::timestamptz
       )`,
      [
        receiptId,
        organizationId,
        evidence.context.order_id,
        evidence.context.plan_id,
        evidence.context.quote_id,
        evidence.context.offer_id,
        actorEmail,
        idempotencyKey,
        requestHash,
        reason,
        ONE_OFF_PACK_CONFIRMATION,
        expectedRowVersion,
        numberValue(updatedOrder.rows[0].row_version),
        evidence.context.plan_version_number,
        JSON.stringify(evidence.snapshot),
        evidence.hash,
        evidence.snapshot.packages.length,
        evidence.snapshot.reservations.length,
        packedAt,
      ],
    )
    const result: OneOffShippingPackCommandResult = {
      orderGlobalId: updatedOrder.rows[0].global_id,
      orderStatus: 'packed',
      rowVersion: numberValue(updatedOrder.rows[0].row_version),
      fulfillmentPlanGlobalId: evidence.context.plan_global_id,
      reviewSnapshotHash: evidence.hash,
      packageCount: evidence.snapshot.packages.length,
      reservationCount: evidence.snapshot.reservations.length,
      packedAt: new Date(packedAt).toISOString(),
      effects: {
        providerWrites: 0,
        labelWrites: 0,
        shipmentWrites: 0,
        inventoryWrites: 0,
      },
      replayed: false,
    }
    const correlationId = receiptId
    await client.query(
      `INSERT INTO operations_domain_events (
         organization_id, aggregate_type, aggregate_id,
         aggregate_global_id, event_type, event_version, payload,
         actor_email, correlation_id, idempotency_key
       ) VALUES (
         $1::uuid, 'operations.order', $2::uuid, $3,
         'shipping.one_off.pack_confirmed', 1, $4::jsonb,
         $5, $6::uuid, $7
       )`,
      [
        organizationId,
        evidence.context.order_id,
        orderGlobalId,
        JSON.stringify({
          ...result,
          reason,
          reservationsRetained: true,
          confirmationStatement: ONE_OFF_PACK_CONFIRMATION,
        }),
        actorEmail,
        correlationId,
        `shipping:one-off-pack:${receiptId}`,
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'shipping.one_off.pack_confirmed',
      aggregateType: 'operations.order',
      aggregateId: orderGlobalId,
      subject: `Packed native one-off ${orderGlobalId} in Shipping`,
      organizationId,
      eventKey: `shipping:one-off-pack:${receiptId}`,
      payload: {
        ...result,
        previousStatus: 'planned',
        previousRowVersion: expectedRowVersion,
        reason,
        reservationsRetained: true,
        confirmationStatement: ONE_OFF_PACK_CONFIRMATION,
      },
    }, client)
    return result
  })
}
