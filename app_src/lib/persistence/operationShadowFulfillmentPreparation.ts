import type { QueryResultRow } from 'pg'
import type { OperationsShadowFulfillmentPreparation } from '@/lib/operations/types'
import { query } from '@/lib/persistence/postgres'

export async function readShadowFulfillmentPreparation(
  organizationId: string,
  orderId: string,
): Promise<OperationsShadowFulfillmentPreparation | null> {
  const executionResult = await query<QueryResultRow & {
    execution_id: string
    execution_global_id: string
    shipment_group_global_id: string
    reconciliation_global_id: string | null
    receipt_global_id: string
    prepared_at: Date
    provider_write_count: number
    postage_purchase_count: number
    label_write_count: number
    commerce_write_count: number
    checkout_run_id: string
    checkout_run_global_id: string
    checkout_package_count: number
    checkout_provider: 'ups_rest' | 'fedex_rest'
    checkout_service_code: string
    checkout_service_name: string
    checkout_carrier_cost_minor: string
    checkout_customer_charge_minor: string
    checkout_currency: string
    fulfillment_run_id: string
    fulfillment_run_global_id: string
    fulfillment_package_count: number
    fulfillment_provider: 'ups_rest' | 'fedex_rest'
    fulfillment_service_code: string
    fulfillment_service_name: string
    fulfillment_carrier_cost_minor: string
    fulfillment_customer_charge_minor: string
    fulfillment_currency: string
    variance_global_id: string
    package_count_delta: number
    carrier_cost_variance_minor: string
    estimated_checkout_variance_minor: string
    allocation_changed: boolean
    material_changed: boolean
    service_changed: boolean
    causes: unknown
  }>(
    `SELECT
       execution.id::text AS execution_id,
       execution.global_id AS execution_global_id,
       shipment_group.global_id AS shipment_group_global_id,
       reconciliation.global_id AS reconciliation_global_id,
       receipt.global_id AS receipt_global_id,
       execution.prepared_at,
       execution.provider_write_count,
       execution.postage_purchase_count,
       execution.label_write_count,
       execution.commerce_write_count,
       checkout_run.id::text AS checkout_run_id,
       checkout_run.global_id AS checkout_run_global_id,
       checkout_run.package_count AS checkout_package_count,
       checkout_run.selected_provider AS checkout_provider,
       checkout_run.selected_service_code AS checkout_service_code,
       checkout_run.selected_service_name AS checkout_service_name,
       checkout_run.selected_carrier_cost_minor::text
         AS checkout_carrier_cost_minor,
       checkout_run.customer_charge_minor::text
         AS checkout_customer_charge_minor,
       checkout_run.currency AS checkout_currency,
       fulfillment_run.id::text AS fulfillment_run_id,
       fulfillment_run.global_id AS fulfillment_run_global_id,
       fulfillment_run.package_count AS fulfillment_package_count,
       fulfillment_run.selected_provider AS fulfillment_provider,
       fulfillment_run.selected_service_code AS fulfillment_service_code,
       fulfillment_run.selected_service_name AS fulfillment_service_name,
       fulfillment_run.selected_carrier_cost_minor::text
         AS fulfillment_carrier_cost_minor,
       fulfillment_run.customer_charge_minor::text
         AS fulfillment_customer_charge_minor,
       fulfillment_run.currency AS fulfillment_currency,
       variance.global_id AS variance_global_id,
       variance.package_count_delta,
       variance.carrier_cost_variance_minor::text,
       variance.realized_margin_minor::text
         AS estimated_checkout_variance_minor,
       variance.allocation_changed,
       variance.material_changed,
       variance.service_changed,
       variance.causes
     FROM operations_fulfillment_executions execution
     JOIN operations_shipment_groups shipment_group
       ON shipment_group.organization_id = execution.organization_id
      AND shipment_group.fulfillment_execution_id = execution.id
     JOIN operations_pack_rate_runs checkout_run
       ON checkout_run.organization_id = execution.organization_id
      AND checkout_run.id = execution.checkout_pack_rate_run_id
     JOIN operations_pack_rate_runs fulfillment_run
       ON fulfillment_run.organization_id = execution.organization_id
      AND fulfillment_run.id = execution.fulfillment_pack_rate_run_id
     JOIN operations_pack_rate_variances variance
       ON variance.organization_id = execution.organization_id
      AND variance.checkout_run_id = execution.checkout_pack_rate_run_id
      AND variance.fulfillment_run_id =
        execution.fulfillment_pack_rate_run_id
     JOIN operations_shopify_checkout_rate_receipts receipt
       ON receipt.organization_id = execution.organization_id
      AND receipt.id = execution.shopify_checkout_receipt_id
     LEFT JOIN operations_shopify_checkout_rate_reconciliations
       reconciliation
       ON reconciliation.organization_id = execution.organization_id
      AND reconciliation.id = execution.shopify_checkout_reconciliation_id
     WHERE execution.organization_id = $1::uuid
       AND execution.order_id = $2::uuid
     ORDER BY execution.prepared_at DESC, execution.id DESC
     LIMIT 1`,
    [organizationId, orderId],
  )
  const execution = executionResult.rows[0]
  if (!execution) return null

  const effectCounts = [
    execution.provider_write_count,
    execution.postage_purchase_count,
    execution.label_write_count,
    execution.commerce_write_count,
  ].map(Number)
  if (effectCounts.some((count) => count !== 0)) {
    throw new Error('OPERATIONS_SHADOW_PREPARATION_EFFECTS_INVALID')
  }

  const runIds = [
    execution.checkout_run_id,
    execution.fulfillment_run_id,
  ]
  const [packageResult, allocationResult, attemptResult] = await Promise.all([
    query<QueryResultRow & {
      run_id: string
      package_key: string
      package_sequence: number
      material_code: string
      material_name: string
      length_mm: number
      width_mm: number
      height_mm: number
      content_weight_grams: number
      tare_weight_grams: number
      gross_weight_grams: number
    }>(
      `SELECT
         package.run_id::text,
         package.package_key,
         package.package_sequence,
         package.material_code,
         package.material_name,
         package.length_mm,
         package.width_mm,
         package.height_mm,
         package.content_weight_grams,
         package.tare_weight_grams,
         package.gross_weight_grams
       FROM operations_pack_rate_run_packages package
       WHERE package.organization_id = $1::uuid
         AND package.run_id = ANY($2::uuid[])
       ORDER BY package.run_id, package.package_sequence`,
      [organizationId, runIds],
    ),
    query<QueryResultRow & {
      run_id: string
      package_key: string
      line_key: string
      product_key: string
      comparison_product_key: string | null
      title: string
      quantity: number
    }>(
      `SELECT
         allocation.run_id::text,
         allocation.package_key,
         allocation.line_key,
         allocation.product_key,
         allocation.comparison_product_key,
         allocation.title,
         allocation.quantity
       FROM operations_pack_rate_run_allocations allocation
       WHERE allocation.organization_id = $1::uuid
         AND allocation.run_id = ANY($2::uuid[])
       ORDER BY
         allocation.run_id, allocation.package_key,
         allocation.line_key, allocation.product_key`,
      [organizationId, runIds],
    ),
    query<QueryResultRow & {
      provider: 'ups_rest' | 'fedex_rest'
      carrier_account_global_id: string
      carrier_account_name: string
      rate_evidence_global_id: string
      environment: 'sandbox'
      attempt_status: 'succeeded' | 'degraded'
      failure_code: string | null
      selected: boolean
    }>(
      `SELECT
         attempt.carrier_provider AS provider,
         carrier_account.global_id AS carrier_account_global_id,
         carrier_account.display_name AS carrier_account_name,
         rate_evidence.global_id AS rate_evidence_global_id,
         attempt.environment,
         attempt.attempt_status,
         attempt.failure_code,
         attempt.selected
       FROM operations_fulfillment_execution_rate_attempts attempt
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = attempt.organization_id
        AND carrier_account.id = attempt.carrier_account_id
       JOIN operations_carrier_rate_requests rate_evidence
         ON rate_evidence.organization_id = attempt.organization_id
        AND rate_evidence.id = attempt.carrier_rate_request_id
       WHERE attempt.organization_id = $1::uuid
         AND attempt.execution_id = $2::uuid
       ORDER BY attempt.carrier_provider`,
      [organizationId, execution.execution_id],
    ),
  ])

  const stage = (
    runId: string,
    runGlobalId: string,
    packageCount: number,
    selectedRate: OperationsShadowFulfillmentPreparation['checkout']['selectedRate'],
  ): OperationsShadowFulfillmentPreparation['checkout'] => ({
    runGlobalId,
    packageCount,
    packages: packageResult.rows
      .filter((item) => item.run_id === runId)
      .map((item) => ({
        packageKey: item.package_key,
        sequence: item.package_sequence,
        materialCode: item.material_code,
        materialName: item.material_name,
        dimensionsMm: {
          length: item.length_mm,
          width: item.width_mm,
          height: item.height_mm,
        },
        contentWeightGrams: item.content_weight_grams,
        tareWeightGrams: item.tare_weight_grams,
        grossWeightGrams: item.gross_weight_grams,
        allocations: allocationResult.rows
          .filter((allocation) => (
            allocation.run_id === runId
            && allocation.package_key === item.package_key
          ))
          .map((allocation) => {
            if (!allocation.comparison_product_key) {
              throw new Error(
                'OPERATIONS_SHADOW_PREPARATION_COMPARISON_IDENTITY_INVALID',
              )
            }
            return {
              lineKey: allocation.line_key,
              productGlobalId: allocation.product_key,
              providerVariantId: allocation.comparison_product_key,
              title: allocation.title,
              quantity: Number(allocation.quantity),
            }
          }),
      })),
    selectedRate,
  })

  const causes = Array.isArray(execution.causes)
    ? execution.causes.filter((cause): cause is string => typeof cause === 'string')
    : []
  return {
    executionGlobalId: execution.execution_global_id,
    shipmentGroupGlobalId: execution.shipment_group_global_id,
    reconciliationGlobalId: execution.reconciliation_global_id,
    checkoutRateReceiptGlobalId: execution.receipt_global_id,
    preparedAt: execution.prepared_at.toISOString(),
    checkout: stage(
      execution.checkout_run_id,
      execution.checkout_run_global_id,
      execution.checkout_package_count,
      {
        provider: execution.checkout_provider,
        serviceCode: execution.checkout_service_code,
        serviceName: execution.checkout_service_name,
        carrierCostMinor: execution.checkout_carrier_cost_minor,
        customerChargeMinor: execution.checkout_customer_charge_minor,
        currency: execution.checkout_currency,
      },
    ),
    fulfillment: stage(
      execution.fulfillment_run_id,
      execution.fulfillment_run_global_id,
      execution.fulfillment_package_count,
      {
        provider: execution.fulfillment_provider,
        serviceCode: execution.fulfillment_service_code,
        serviceName: execution.fulfillment_service_name,
        carrierCostMinor: execution.fulfillment_carrier_cost_minor,
        customerChargeMinor: execution.fulfillment_customer_charge_minor,
        currency: execution.fulfillment_currency,
      },
    ),
    variance: {
      globalId: execution.variance_global_id,
      packageCountDelta: execution.package_count_delta,
      carrierCostVarianceMinor: execution.carrier_cost_variance_minor,
      estimatedCheckoutVarianceMinor:
        execution.estimated_checkout_variance_minor,
      allocationChanged: execution.allocation_changed,
      materialChanged: execution.material_changed,
      serviceChanged: execution.service_changed,
      causes,
    },
    providerAttempts: attemptResult.rows.map((attempt) => ({
      provider: attempt.provider,
      carrierAccountGlobalId: attempt.carrier_account_global_id,
      carrierAccountName: attempt.carrier_account_name,
      rateEvidenceGlobalId: attempt.rate_evidence_global_id,
      environment: attempt.environment,
      status: attempt.attempt_status,
      failureCode: attempt.failure_code,
      selected: attempt.selected,
    })),
    effects: {
      providerWriteCount: 0,
      postagePurchaseCount: 0,
      labelWriteCount: 0,
      commerceWriteCount: 0,
    },
  }
}
