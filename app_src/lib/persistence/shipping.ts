import type { QueryResultRow } from 'pg'

import type {
  ShippingRecord,
  ShippingWorkspace,
} from '@/lib/operations/shipping'
import { query } from '@/lib/persistence/postgres'

type ShippingRecordRow = QueryResultRow & {
  record_id: string
  record_kind: ShippingRecord['kind']
  transport_mode: ShippingRecord['transportMode']
  order_global_id: string
  order_number: string
  reference_number: string
  customer_name: string
  destination: string
  record_status: string
  carrier_name: string | null
  service_code: string | null
  tracking_number: string | null
  tracking_numbers: string[]
  handling_unit_count: string
  execution_mode: 'test' | 'live' | null
  standalone_one_off_execution_eligible: boolean
  occurred_at: Date
}

function record(row: ShippingRecordRow): ShippingRecord {
  return {
    recordId: row.record_id,
    kind: row.record_kind,
    transportMode: row.transport_mode,
    orderGlobalId: row.order_global_id,
    orderNumber: row.order_number,
    referenceNumber: row.reference_number,
    customerName: row.customer_name,
    destination: row.destination,
    status: row.record_status,
    carrierName: row.carrier_name,
    serviceCode: row.service_code,
    trackingNumber: row.tracking_number,
    trackingNumbers: row.tracking_numbers,
    handlingUnitCount: Number(row.handling_unit_count),
    executionMode: row.execution_mode,
    standaloneOneOffExecutionEligible:
      row.standalone_one_off_execution_eligible,
    occurredAt: row.occurred_at.toISOString(),
  }
}

export async function readShippingWorkspaceFromPostgres(input: {
  organizationId: string
  canView: boolean
  canCreate: boolean
  canPurchaseLivePostage: boolean
}): Promise<ShippingWorkspace> {
  const result = await query<ShippingRecordRow>(
    `WITH shipping_orders AS (
       SELECT source_order.id, source_order.global_id, source_order.order_number,
              source_order.external_order_id AS reference_number,
              source_order.status, source_order.updated_at,
              source_order.ship_to,
              source_order.source_provider,
              source_order.order_type,
              COALESCE(customer.name, source_order.ship_to->>'name') AS customer_name,
              quote.execution_mode,
              (
                source_order.source_provider = 'clawpilot_native'
                AND source_order.order_type = 'one_off'
                AND source_order.status = 'packed'
                AND quote.execution_mode IS NOT NULL
                AND operations_one_off_plan_execution_is_exact(
                  source_order.organization_id,
                  plan.id,
                  quote.execution_mode
                )
                AND (
                  NOT EXISTS (
                    SELECT 1
                    FROM operations_packages package_state
                    WHERE package_state.organization_id = source_order.organization_id
                      AND package_state.plan_id = plan.id
                      AND package_state.status <> 'packed'
                  )
                  OR NOT EXISTS (
                    SELECT 1
                    FROM operations_packages package_state
                    WHERE package_state.organization_id = source_order.organization_id
                      AND package_state.plan_id = plan.id
                      AND package_state.status <> 'labeled'
                  )
                )
              ) AS standalone_one_off_execution_eligible,
              plan.id AS plan_id,
              COALESCE((
                SELECT count(*)
                FROM operations_packages package
                WHERE package.organization_id = source_order.organization_id
                  AND package.plan_id = plan.id
              ), 0)::text AS package_count
       FROM operations_orders source_order
       LEFT JOIN crm_organizations customer
         ON customer.pipeline_id = source_order.pipeline_id
        AND customer.id = source_order.customer_id
       JOIN LATERAL (
         SELECT candidate.id, candidate.one_off_quote_id
         FROM operations_fulfillment_plans candidate
         WHERE candidate.organization_id = source_order.organization_id
           AND candidate.order_id = source_order.id
         ORDER BY candidate.version_number DESC, candidate.id DESC
         LIMIT 1
       ) plan ON true
       LEFT JOIN operations_one_off_shipment_quotes quote
         ON quote.organization_id = source_order.organization_id
        AND quote.id = plan.one_off_quote_id
       WHERE source_order.organization_id = $1::uuid
         AND source_order.archived_at IS NULL
     ), parcel_shipments AS (
       SELECT shipment.order_id,
              CASE
                WHEN bool_and(shipment.status = 'delivered') THEN 'delivered'
                WHEN bool_or(shipment.status = 'exception') THEN 'exception'
                WHEN bool_and(shipment.status = 'voided') THEN 'voided'
                WHEN bool_or(shipment.status = 'in_transit') THEN 'in_transit'
                ELSE 'confirmed'
              END AS record_status,
              max(shipment.shipped_at) AS occurred_at,
              CASE WHEN count(DISTINCT label.carrier) = 1
                THEN min(label.carrier) ELSE 'Multiple carriers' END AS carrier_name,
              CASE WHEN count(DISTINCT label.service_code) = 1
                THEN min(label.service_code) ELSE NULL END AS service_code,
              CASE WHEN count(DISTINCT shipment.tracking_number) = 1
                THEN min(shipment.tracking_number) ELSE NULL END AS tracking_number,
              array_agg(DISTINCT shipment.tracking_number
                ORDER BY shipment.tracking_number) AS tracking_numbers,
              count(*)::text AS shipment_count
       FROM operations_shipments shipment
       JOIN operations_labels label
         ON label.organization_id = shipment.organization_id
        AND label.id = shipment.label_id
       WHERE shipment.organization_id = $1::uuid
       GROUP BY shipment.order_id
     )
     SELECT shipping_order.global_id AS record_id,
            CASE WHEN parcel.order_id IS NULL
              THEN 'shipment_plan' ELSE 'parcel_shipment' END AS record_kind,
            'parcel' AS transport_mode,
            shipping_order.global_id AS order_global_id,
            shipping_order.order_number,
            shipping_order.reference_number,
            shipping_order.customer_name,
            concat_ws(', ',
              NULLIF(shipping_order.ship_to->>'city', ''),
              NULLIF(COALESCE(shipping_order.ship_to->>'region', shipping_order.ship_to->>'state'), '')
            ) AS destination,
            COALESCE(parcel.record_status, shipping_order.status) AS record_status,
            parcel.carrier_name,
            parcel.service_code,
            parcel.tracking_number,
            COALESCE(parcel.tracking_numbers, ARRAY[]::text[]) AS tracking_numbers,
            COALESCE(parcel.shipment_count, shipping_order.package_count) AS handling_unit_count,
            shipping_order.execution_mode,
            shipping_order.standalone_one_off_execution_eligible,
            COALESCE(parcel.occurred_at, shipping_order.updated_at) AS occurred_at
     FROM shipping_orders shipping_order
     LEFT JOIN parcel_shipments parcel ON parcel.order_id = shipping_order.id
     WHERE parcel.order_id IS NOT NULL
        OR (
          shipping_order.source_provider = 'clawpilot_native'
          AND shipping_order.order_type = 'one_off'
          AND shipping_order.execution_mode IS NOT NULL
        )
     UNION ALL
     SELECT tender.global_id AS record_id,
            'ltl_tender' AS record_kind,
            'ltl' AS transport_mode,
            source_order.global_id AS order_global_id,
            source_order.order_number,
            source_order.external_order_id AS reference_number,
            customer.name AS customer_name,
            concat_ws(', ',
              NULLIF(source_order.ship_to->>'city', ''),
              NULLIF(COALESCE(source_order.ship_to->>'region', source_order.ship_to->>'state'), '')
            ) AS destination,
            tender.state AS record_status,
            tender.executing_carrier_name AS carrier_name,
            tender.service_code,
            COALESCE(tender.pro_number, tender.provider_tender_reference) AS tracking_number,
            array_remove(
              ARRAY[COALESCE(tender.pro_number, tender.provider_tender_reference)]::text[],
              NULL
            ) AS tracking_numbers,
            handling_plan.handling_unit_count::text,
            CASE tender.environment
              WHEN 'sandbox' THEN 'test' ELSE 'live' END AS execution_mode,
            false AS standalone_one_off_execution_eligible,
            COALESCE(tender.completed_at, tender.requested_at) AS occurred_at
     FROM operations_freight_tender_attempts tender
     JOIN operations_orders source_order
       ON source_order.organization_id = tender.organization_id
      AND source_order.id = tender.order_id
     JOIN crm_organizations customer
       ON customer.pipeline_id = source_order.pipeline_id
      AND customer.id = source_order.customer_id
     JOIN operations_outbound_handling_unit_plans handling_plan
       ON handling_plan.organization_id = tender.organization_id
      AND handling_plan.id = tender.handling_unit_plan_id
     WHERE tender.organization_id = $1::uuid
       AND tender.action = 'tender'
       AND tender.state = 'succeeded'
     ORDER BY occurred_at DESC, record_id DESC`,
    [input.organizationId],
  )

  return {
    organizationId: input.organizationId,
    capabilities: {
      canView: input.canView,
      canCreate: input.canCreate,
      canPurchaseLivePostage: input.canPurchaseLivePostage,
    },
    records: result.rows.map(record),
    pickupAvailability: {
      parcel: {
        available: false,
        blocker:
          'Parcel pickup scheduling is not connected yet. It will require an eligible packed shipment and exact carrier pickup authority.',
      },
      ltl: {
        available: false,
        blocker:
          'LTL pickup scheduling is not connected yet. Pickup will be bound to the selected provider, rated pallet plan, and freight tender.',
      },
    },
  }
}
