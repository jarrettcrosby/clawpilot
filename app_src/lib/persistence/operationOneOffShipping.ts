import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  CarrierIntegrationRequestError,
  resolveCarrierOneOffVoidRuntime,
  resolveCarrierProductionShippingRuntime,
  resolveCarrierSandboxShippingRuntime,
} from '@/lib/integrations/carrierIntegrations'
import {
  CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
  CarrierOneOffGroupError,
  carrierOneOffGroupLifecycleMode,
  executeCarrierOneOffGroupShipment,
  executeCarrierOneOffGroupVoid,
  prepareCarrierOneOffGroupRequest,
  prepareCarrierOneOffGroupVoidRequest,
  type CarrierOneOffGroupRuntime,
  type CarrierOneOffGroupShipmentFixture,
  type CarrierOneOffGroupShipmentResult,
} from '@/lib/integrations/carrierOneOffGroupShipment'
import {
  ONE_OFF_MAX_SYNCHRONOUS_PACKAGES,
  oneOffProviderLabel,
  oneOffShipmentHash,
  type OneOffCarrierGroupCommandResult,
  type OneOffCarrierProvider,
  type OneOffCarrierSelectionInput,
  type OneOffExecutionMode,
  type OneOffPackedRateRefresh,
  type OneOffShipmentExecutionState,
  type OneOffShipmentPackageInput,
  type OneOffShipmentQuoteInput,
} from '@/lib/operations/oneOffShipments'
import { defaultCanonicalPackageProfile } from '@/lib/operations/packageCatalog'
import { enqueueOperationsPrintJobInPostgres } from '@/lib/persistence/operationPrintDelivery'
import {
  OneOffShipmentPersistenceError,
  quoteOneOffShipmentInPostgres,
} from '@/lib/persistence/oneOffShipments'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type JsonObject = Record<string, unknown>
type Provider = 'ups_rest' | 'fedex_rest'
type Environment = 'sandbox' | 'production'
type GroupState = 'prepared' | 'succeeded' | 'failed' | 'unknown'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const QUOTE_GLOBAL_ID = /^goq(?:[0-9]{7}|[0-9a-v]{12})$/
const OFFER_GLOBAL_ID = /^goo(?:[0-9]{7}|[0-9a-v]{12})$/
const PRINTER_GLOBAL_ID = /^gpr(?:[0-9]{7}|[0-9a-v]{12})$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/

function fail(code: string, message: string, status = 409): never {
  throw new OneOffShipmentPersistenceError(code, message, status)
}

function requiredText(value: unknown, label: string, maximum: number) {
  const normalized = String(value ?? '').trim()
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail('OPERATIONS_ONE_OFF_GROUP_REQUEST_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function requiredId(value: unknown, label: string, pattern: RegExp) {
  const normalized = requiredText(value, label, 50)
  if (!pattern.test(normalized)) {
    fail('OPERATIONS_ONE_OFF_GROUP_REQUEST_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function requiredOrganizationId(value: unknown) {
  return requiredId(value, 'Organization', UUID)
}

function requiredVersion(value: unknown) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail('OPERATIONS_ONE_OFF_GROUP_REQUEST_INVALID', 'Order version is invalid', 400)
  }
  return parsed
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

function optionalPrinter(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  return requiredId(value, 'Preferred printer', PRINTER_GLOBAL_ID)
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail('OPERATIONS_ONE_OFF_GROUP_EVIDENCE_INVALID', 'Stored numeric evidence is invalid', 500)
  return parsed
}

function addressParty(value: JsonObject, fallbackName: string) {
  return {
    name: String(value.name || value.companyName || fallbackName).trim(),
    line1: String(value.line1 || value.street || '').trim(),
    line2: String(value.line2 || '').trim() || null,
    city: String(value.city || '').trim(),
    region: String(value.region || value.state || '').trim().toUpperCase(),
    postalCode: String(value.postalCode || value.postal_code || '').trim(),
    countryCode: String(value.countryCode || value.country || 'US')
      .trim().toUpperCase() as 'US',
  }
}

type PackedLineRow = QueryResultRow & {
  kind: 'existing' | 'ad_hoc'
  external_line_id: string
  product_global_id: string | null
  quantity: string
  item_snapshot: JsonObject | null
}

type PackedPackageRow = QueryResultRow & {
  id: string
  global_id: string
  package_number: number
  status: string
  length_mm: number
  width_mm: number
  height_mm: number
  weight_grams: number
  quote_package_key: string
  allocations: Array<{ lineKey: string; quantity: number }>
}

type GroupContext = QueryResultRow & {
  order_id: string
  order_global_id: string
  order_number: string
  order_status: string
  row_version: string
  currency: string
  plan_id: string
  plan_global_id: string
  warehouse_id: string
  warehouse_global_id: string
  warehouse_address: JsonObject
  customer_global_id: string | null
  inventory_pool_global_id: string | null
  receiving_location_global_id: string | null
  planning_quote_id: string
  planning_quote_global_id: string
  planning_offer_id: string
  planning_offer_global_id: string
  execution_mode: OneOffExecutionMode
  environment: Environment
  reference_number: string
  requested_delivery_at: Date | null
  destination_snapshot: JsonObject
  planning_packages_snapshot: OneOffShipmentPackageInput[]
  planning_carrier_selection_schema_version: number | null
  planning_required_carrier_selections: unknown
  provider: Provider
  service_code: string
  service_name: string
  planning_amount_minor: string
  integration_account_id: string
  integration_account_global_id: string
  carrier_account_id: string
  carrier_account_global_id: string
  carrier_rate_id: string
  carrier_rate_global_id: string
}

async function dbQuery<T extends QueryResultRow>(
  client: PoolClient | null,
  sql: string,
  values: unknown[],
) {
  return client ? client.query<T>(sql, values) : query<T>(sql, values)
}

async function readGroupContext(
  organizationId: string,
  orderGlobalId: string,
  client: PoolClient | null,
  lock: boolean,
) {
  const result = await dbQuery<GroupContext>(
    client,
    `SELECT source_order.id::text AS order_id,
            source_order.global_id AS order_global_id,
            source_order.order_number, source_order.status AS order_status,
            source_order.row_version::text, source_order.currency,
            plan.id::text AS plan_id, plan.global_id AS plan_global_id,
            plan.warehouse_id::text, warehouse.global_id AS warehouse_global_id,
            warehouse.address AS warehouse_address,
            customer.reference_code AS customer_global_id,
            pool.global_id AS inventory_pool_global_id,
            location.global_id AS receiving_location_global_id,
            planning_quote.id::text AS planning_quote_id,
            planning_quote.global_id AS planning_quote_global_id,
            planning_offer.id::text AS planning_offer_id,
            planning_offer.global_id AS planning_offer_global_id,
            planning_quote.execution_mode, planning_offer.environment,
            planning_quote.reference_number,
            planning_quote.requested_delivery_at,
            planning_quote.destination_snapshot,
            planning_quote.packages_snapshot AS planning_packages_snapshot,
            planning_quote.carrier_selection_schema_version
              AS planning_carrier_selection_schema_version,
            planning_quote.required_carrier_selections
              AS planning_required_carrier_selections,
            planning_offer.provider, planning_offer.service_code,
            planning_offer.service_name,
            planning_offer.amount_minor::text AS planning_amount_minor,
            planning_offer.integration_account_id::text,
            integration.global_id AS integration_account_global_id,
            planning_offer.carrier_account_id::text,
            carrier_account.global_id AS carrier_account_global_id,
            selected_rate.id::text AS carrier_rate_id,
            selected_rate.global_id AS carrier_rate_global_id
     FROM operations_orders source_order
     JOIN LATERAL (
       SELECT candidate.*
       FROM operations_fulfillment_plans candidate
       WHERE candidate.organization_id = source_order.organization_id
         AND candidate.order_id = source_order.id
       ORDER BY candidate.version_number DESC, candidate.created_at DESC,
                candidate.id DESC
       LIMIT 1
     ) plan ON true
     JOIN operations_warehouses warehouse
       ON warehouse.organization_id = plan.organization_id
      AND warehouse.id = plan.warehouse_id
     JOIN operations_one_off_shipment_quotes planning_quote
       ON planning_quote.organization_id = plan.organization_id
      AND planning_quote.id = plan.one_off_quote_id
     JOIN operations_one_off_shipment_quote_offers planning_offer
       ON planning_offer.organization_id = plan.organization_id
      AND planning_offer.quote_id = plan.one_off_quote_id
      AND planning_offer.id = plan.one_off_offer_id
     JOIN operations_integration_accounts integration
       ON integration.organization_id = planning_offer.organization_id
      AND integration.id = planning_offer.integration_account_id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = planning_offer.organization_id
      AND carrier_account.integration_account_id = planning_offer.integration_account_id
      AND carrier_account.id = planning_offer.carrier_account_id
     JOIN operations_carrier_rates selected_rate
       ON selected_rate.organization_id = plan.organization_id
      AND selected_rate.plan_id = plan.id
      AND selected_rate.selected = true
      AND selected_rate.one_off_quote_id = plan.one_off_quote_id
      AND selected_rate.one_off_offer_id = plan.one_off_offer_id
     LEFT JOIN crm_organizations customer
       ON customer.pipeline_id = planning_quote.pipeline_id
      AND customer.id = planning_quote.customer_id
     LEFT JOIN operations_inventory_pools pool
       ON pool.organization_id = planning_quote.organization_id
      AND pool.id = planning_quote.inventory_pool_id
     LEFT JOIN operations_locations location
       ON location.organization_id = planning_quote.organization_id
      AND location.id = planning_quote.receiving_location_id
     WHERE source_order.organization_id = $1::uuid
       AND source_order.global_id = $2
       AND source_order.source_provider = 'clawpilot_native'
       AND source_order.order_type = 'one_off'
       AND source_order.archived_at IS NULL
       AND operations_one_off_plan_execution_is_exact(
         plan.organization_id, plan.id, planning_quote.execution_mode
       )
     LIMIT 1
     ${lock ? 'FOR UPDATE OF source_order' : ''}`,
    [organizationId, orderGlobalId],
  )
  if (!result.rows[0]) {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_CONTEXT_UNAVAILABLE',
      'The exact native one-off order, plan, selected rate, and carrier authority were not found',
      404,
    )
  }
  return result.rows[0]
}

async function readPackedLines(
  organizationId: string,
  orderId: string,
  client: PoolClient | null = null,
) {
  const result = await dbQuery<PackedLineRow>(
    client,
    `SELECT packed.kind, packed.external_line_id, packed.product_global_id,
            packed.quantity, packed.item_snapshot
     FROM (
       SELECT 'existing'::text AS kind, line.external_line_id,
              product.reference_code AS product_global_id,
              line.quantity::text, NULL::jsonb AS item_snapshot,
              line.id AS stable_id
       FROM operations_current_order_lines line
       JOIN crm_products product
         ON product.pipeline_id = line.pipeline_id AND product.id = line.product_id
       WHERE line.organization_id = $1::uuid AND line.order_id = $2::uuid
       UNION ALL
       SELECT 'ad_hoc'::text, line.line_key, NULL::text,
              line.quantity::text, line.item_snapshot, line.id
       FROM operations_one_off_ad_hoc_order_lines line
       WHERE line.organization_id = $1::uuid AND line.order_id = $2::uuid
     ) packed
     ORDER BY packed.external_line_id, packed.stable_id`,
    [organizationId, orderId],
  )
  return result.rows
}

async function readPackedPackages(
  organizationId: string,
  planId: string,
  quoteId: string,
  client: PoolClient | null = null,
  lock = false,
) {
  const result = await dbQuery<PackedPackageRow>(
    client,
    `SELECT package.id::text, package.global_id, package.package_number,
            package.status, package.length_mm, package.width_mm,
            package.height_mm, package.weight_grams,
            quote.packages_snapshot->(package.package_number - 1)->>'packageKey'
              AS quote_package_key,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'lineKey', allocation.line_key,
                'quantity', allocation.quantity
              ) ORDER BY allocation.line_key)
              FROM (
                SELECT order_line.external_line_id AS line_key,
                       content.quantity
                FROM operations_package_contents content
                JOIN operations_current_order_lines order_line
                  ON order_line.organization_id = content.organization_id
                 AND order_line.id = content.order_line_id
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
              ) allocation
            ), '[]'::jsonb) AS allocations
     FROM operations_packages package
     JOIN operations_one_off_shipment_quotes quote
       ON quote.organization_id = package.organization_id
      AND quote.id = $3::uuid
     WHERE package.organization_id = $1::uuid AND package.plan_id = $2::uuid
     ORDER BY package.package_number, package.id
     ${lock ? 'FOR UPDATE OF package' : ''}`,
    [organizationId, planId, quoteId],
  )
  return result.rows
}

function assertPackedContext(
  context: GroupContext,
  packages: PackedPackageRow[],
  expectedRowVersion: number,
) {
  if (context.order_status !== 'packed') {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_NOT_PACKED',
      'Finish the canonical pick and pack workflow before refreshing or purchasing postage',
    )
  }
  if (
    packages.length < 1
    || packages.length > ONE_OFF_MAX_SYNCHRONOUS_PACKAGES
    || packages.some((item, index) => (
      item.package_number !== index + 1 || item.status !== 'packed'
    ))
  ) {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_PACKAGE_SET_INVALID',
      `The complete packed package set must contain 1-${ONE_OFF_MAX_SYNCHRONOUS_PACKAGES} contiguous parcels`,
    )
  }
  if (numberValue(context.row_version) !== expectedRowVersion) {
    fail(
      'OPERATIONS_ORDER_VERSION_CONFLICT',
      'The order changed. Refresh it before continuing.',
    )
  }
}

export function packedRerateCarrierSelections(
  schemaVersion: unknown,
  value: unknown,
): OneOffCarrierSelectionInput[] {
  const unavailable = (): never => fail(
    'OPERATIONS_ONE_OFF_PACKED_RATE_CARRIER_SELECTION_UNAVAILABLE',
    'The planning quote does not contain exact carrier selection evidence; create a new one-off plan before refreshing packed rates',
  )
  if (schemaVersion !== 1 || !Array.isArray(value) || value.length < 1 || value.length > 3) {
    return unavailable()
  }

  const providerRank = {
    ups_rest: 0,
    fedex_rest: 1,
    wwex_speedship: 2,
  } as const
  let priorProviderRank = -1
  const selections: OneOffCarrierSelectionInput[] = []

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return unavailable()
    }
    const selection = candidate as Record<string, unknown>
    const provider = selection.provider
    if (
      provider !== 'ups_rest'
      && provider !== 'fedex_rest'
      && provider !== 'wwex_speedship'
    ) {
      return unavailable()
    }
    const rank = providerRank[provider]
    if (rank <= priorProviderRank) return unavailable()
    priorProviderRank = rank

    const integrationAccountGlobalId = selection.integrationAccountGlobalId
    const carrierAccountGlobalId = selection.carrierAccountGlobalId
    const credentialVersion = selection.credentialVersion
    if (
      typeof integrationAccountGlobalId !== 'string'
      || !/^gia(?:[0-9]{7}|[0-9a-v]{12})$/.test(integrationAccountGlobalId)
      || !Number.isSafeInteger(credentialVersion)
      || Number(credentialVersion) < 1
      || (
        provider === 'wwex_speedship'
          ? carrierAccountGlobalId !== null
          : typeof carrierAccountGlobalId !== 'string'
            || !/^gac(?:[0-9]{7}|[0-9a-v]{12})$/.test(carrierAccountGlobalId)
      )
      || selection.selectionKey !== (
        `${provider}:${integrationAccountGlobalId}:${carrierAccountGlobalId || 'none'}:v${credentialVersion}`
      )
      || !Array.isArray(selection.packageCodes)
      || selection.packageCodes.length < 1
    ) {
      return unavailable()
    }

    let priorPackageKey: string | null = null
    for (const packageCode of selection.packageCodes) {
      if (!packageCode || typeof packageCode !== 'object' || Array.isArray(packageCode)) {
        return unavailable()
      }
      const code = packageCode as Record<string, unknown>
      if (
        typeof code.packageKey !== 'string'
        || !code.packageKey
        || typeof code.catalogEntryId !== 'string'
        || !code.catalogEntryId
        || code.catalogVersion !== 'operations.package_catalog.v1'
        || typeof code.providerPackageCode !== 'string'
        || !code.providerPackageCode
        || (priorPackageKey !== null && priorPackageKey >= code.packageKey)
      ) {
        return unavailable()
      }
      priorPackageKey = code.packageKey
    }

    selections.push({
      provider,
      integrationAccountGlobalId,
      carrierAccountGlobalId: carrierAccountGlobalId as string | null,
    })
  }
  return selections
}

function quoteInput(
  context: GroupContext,
  lines: PackedLineRow[],
  packages: PackedPackageRow[],
): OneOffShipmentQuoteInput {
  const destination = context.destination_snapshot
  const shipToPhone = String(destination.phone || '').trim()
  const shipFromPhone = String(destination.shipFromPhone || '').trim()
  if (!shipToPhone || !shipFromPhone || typeof destination.residential !== 'boolean') {
    fail(
      'OPERATIONS_ONE_OFF_PACKED_RATE_ADDRESS_INVALID',
      'The immutable one-off address is missing sender phone, recipient phone, or residential choice',
    )
  }
  return {
    executionMode: context.execution_mode,
    customerGlobalId: context.customer_global_id,
    warehouseGlobalId: context.warehouse_global_id,
    inventoryPoolGlobalId: context.inventory_pool_global_id,
    receivingLocationGlobalId: context.receiving_location_global_id,
    referenceNumber: context.reference_number,
    currency: context.currency,
    requestedDeliveryAt: context.requested_delivery_at
      ? new Date(context.requested_delivery_at).toISOString()
      : null,
    shipFromPhone,
    shipToPhone,
    shipToResidential: destination.residential,
    selectedCarriers: packedRerateCarrierSelections(
      context.planning_carrier_selection_schema_version,
      context.planning_required_carrier_selections,
    ),
    shipTo: {
      name: String(destination.name || '').trim(),
      line1: String(destination.line1 || '').trim(),
      line2: String(destination.line2 || '').trim() || null,
      city: String(destination.city || '').trim(),
      region: String(destination.region || '').trim(),
      postalCode: String(destination.postalCode || '').trim(),
      country: String(destination.country || 'US').trim(),
    },
    lines: lines.map((line) => {
      if (line.kind === 'ad_hoc') {
        const snapshot = line.item_snapshot || {}
        return {
          kind: 'ad_hoc' as const,
          lineKey: line.external_line_id,
          name: String(snapshot.name || '').trim(),
          sku: String(snapshot.sku || '').trim() || null,
          quantity: numberValue(line.quantity),
          unitPriceMinor: numberValue(snapshot.unitPriceMinor),
          unitWeightGrams: numberValue(snapshot.unitWeightGrams),
          unitDimensionsMm: {
            length: numberValue((snapshot.unitDimensionsMm as JsonObject)?.length),
            width: numberValue((snapshot.unitDimensionsMm as JsonObject)?.width),
            height: numberValue((snapshot.unitDimensionsMm as JsonObject)?.height),
          },
        }
      }
      if (!line.product_global_id) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_EVIDENCE_INVALID',
          'The packed product line is missing its immutable product reference',
          500,
        )
      }
      return {
        kind: 'existing' as const,
        lineKey: line.external_line_id,
        productGlobalId: line.product_global_id,
        quantity: numberValue(line.quantity),
      }
    }),
    packages: packages.map((item, index) => ({
      packageKey: item.quote_package_key,
      packageProfile:
        context.planning_packages_snapshot[index]?.packageProfile
        || defaultCanonicalPackageProfile(),
      description: String(
        context.planning_packages_snapshot[index]?.description
        || `Parcel ${item.package_number}`,
      ).trim(),
      dimensionsMm: {
        length: item.length_mm,
        width: item.width_mm,
        height: item.height_mm,
      },
      grossWeightGrams: item.weight_grams,
      allocations: item.allocations.map((allocation) => ({
        lineKey: String(allocation.lineKey),
        quantity: numberValue(allocation.quantity),
      })),
    })),
  }
}

export async function readOneOffCarrierGroupExecutionModeInPostgres(input: {
  organizationId: string
  orderGlobalId: string
}) {
  const organizationId = requiredOrganizationId(input.organizationId)
  const orderGlobalId = requiredId(input.orderGlobalId, 'Order', ORDER_GLOBAL_ID)
  const context = await readGroupContext(organizationId, orderGlobalId, null, false)
  return context.execution_mode
}

export async function readOneOffShipmentExecutionStateFromPostgres(input: {
  organizationId: string
  orderGlobalId: string
}): Promise<OneOffShipmentExecutionState> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const orderGlobalId = requiredId(input.orderGlobalId, 'Order', ORDER_GLOBAL_ID)
  const context = await readGroupContext(organizationId, orderGlobalId, null, false)
  const packages = await readPackedPackages(
    organizationId,
    context.plan_id,
    context.planning_quote_id,
  )
  const packedRateRows = await query<{
    quote_global_id: string
    idempotency_key: string
    expires_at: Date
    status: 'succeeded' | 'partial' | 'failed'
    consumed: boolean
    offer_global_id: string
    provider: OneOffCarrierProvider
    environment: Environment
    service_code: string
    service_name: string
    amount_minor: string
    currency: string
    transit_days: number | null
    estimated_delivery_at: Date | null
    rate_evidence_global_id: string
    integration_account_global_id: string
    carrier_account_global_id: string | null
    credential_version: number
  }>(
    `SELECT packed_quote.global_id AS quote_global_id,
            packed_quote.idempotency_key,
            packed_quote.expires_at, packed_quote.status,
            EXISTS (
              SELECT 1
              FROM operations_one_off_purchase_quote_consumptions consumed
              WHERE consumed.organization_id = packed_quote.organization_id
                AND consumed.quote_id = packed_quote.id
            ) AS consumed,
            packed_offer.global_id AS offer_global_id,
            packed_offer.provider, packed_offer.environment,
            packed_offer.service_code, packed_offer.service_name,
            packed_offer.amount_minor::text, packed_offer.currency,
            packed_offer.transit_days, packed_offer.estimated_delivery_at,
            packed_offer.rate_evidence_global_id,
            integration.global_id AS integration_account_global_id,
            carrier_account.global_id AS carrier_account_global_id,
            packed_offer.credential_version
     FROM operations_one_off_shipment_quotes packed_quote
     JOIN operations_one_off_shipment_quote_offers packed_offer
       ON packed_offer.organization_id = packed_quote.organization_id
      AND packed_offer.quote_id = packed_quote.id
     JOIN operations_integration_accounts integration
       ON integration.organization_id = packed_offer.organization_id
      AND integration.id = packed_offer.integration_account_id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = packed_offer.organization_id
      AND carrier_account.integration_account_id = packed_offer.integration_account_id
      AND carrier_account.id = packed_offer.carrier_account_id
     WHERE packed_quote.organization_id = $1::uuid
       AND packed_quote.packed_rerate_order_id = $2::uuid
       AND packed_quote.packed_rerate_plan_id = $3::uuid
       AND packed_offer.provider = $4
       AND packed_offer.service_code = $5
       AND packed_offer.integration_account_id = $6::uuid
       AND packed_offer.carrier_account_id = $7::uuid
       AND packed_offer.environment = $8
       AND packed_quote.id = (
         SELECT candidate.id
         FROM operations_one_off_shipment_quotes candidate
         WHERE candidate.organization_id = packed_quote.organization_id
           AND candidate.packed_rerate_order_id = packed_quote.packed_rerate_order_id
           AND candidate.packed_rerate_plan_id = packed_quote.packed_rerate_plan_id
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
       )
     ORDER BY packed_offer.amount_minor, packed_offer.id`,
    [
      organizationId,
      context.order_id,
      context.plan_id,
      context.provider,
      context.service_code,
      context.integration_account_id,
      context.carrier_account_id,
      context.environment,
    ],
  )
  const group = await query<GroupAttemptRow & {
    create_idempotency_key: string
    purchase_quote_global_id: string
    purchase_offer_global_id: string
    void_global_id: string | null
    void_idempotency_key: string | null
    void_action: 'void' | 'close_sample' | null
    void_state: GroupState | null
  }>(
    `SELECT create_attempt.id::text, create_attempt.global_id,
            create_attempt.action, create_attempt.state,
            create_attempt.request_hash, create_attempt.redacted_request,
            create_attempt.redacted_response, create_attempt.provider_reference,
            create_attempt.master_tracking_number,
            create_attempt.provider_shipment_id,
            create_attempt.selected_amount_minor::text,
            create_attempt.currency,
            create_attempt.provider_charge_minor::text,
            create_attempt.provider_charge_currency,
            create_attempt.charge_variance_minor::text,
            create_attempt.package_count, create_attempt.environment,
            create_attempt.provider, create_attempt.service_code,
            create_attempt.error_code,
            create_attempt.idempotency_key AS create_idempotency_key,
            purchase_quote.global_id AS purchase_quote_global_id,
            purchase_offer.global_id AS purchase_offer_global_id,
            close_attempt.global_id AS void_global_id,
            close_attempt.idempotency_key AS void_idempotency_key,
            close_attempt.action AS void_action,
            close_attempt.state AS void_state
     FROM operations_one_off_carrier_group_attempts create_attempt
     LEFT JOIN LATERAL (
       SELECT candidate.global_id, candidate.idempotency_key,
              candidate.action, candidate.state
       FROM operations_one_off_carrier_group_attempts candidate
       WHERE candidate.organization_id = create_attempt.organization_id
         AND candidate.create_attempt_id = create_attempt.id
         AND candidate.action IN ('void', 'close_sample')
       ORDER BY candidate.created_at DESC, candidate.id DESC
       LIMIT 1
     ) close_attempt ON true
     JOIN operations_one_off_shipment_quotes purchase_quote
       ON purchase_quote.organization_id = create_attempt.organization_id
      AND purchase_quote.id = create_attempt.purchase_quote_id
     JOIN operations_one_off_shipment_quote_offers purchase_offer
       ON purchase_offer.organization_id = create_attempt.organization_id
      AND purchase_offer.quote_id = create_attempt.purchase_quote_id
      AND purchase_offer.id = create_attempt.purchase_offer_id
     WHERE create_attempt.organization_id = $1::uuid
       AND create_attempt.order_id = $2::uuid
       AND create_attempt.plan_id = $3::uuid
       AND create_attempt.action = 'create'
     ORDER BY create_attempt.created_at DESC, create_attempt.id DESC
     LIMIT 1`,
    [organizationId, context.order_id, context.plan_id],
  )
  const create = group.rows[0] || null
  const labels = create
    ? await query<ResultLabelRow & {
        print_job_global_id: string | null
        print_status: 'queued' | 'printed' | 'failed' | 'rerouted' | null
        print_warning: string | null
      }>(
        `SELECT package.global_id AS package_global_id,
                member.package_number, label.global_id AS label_global_id,
                label.tracking_number, label.status,
                print_job.global_id AS print_job_global_id,
                print_job.status AS print_status,
                print_job.last_error AS print_warning
         FROM operations_one_off_carrier_group_members member
         JOIN operations_packages package
           ON package.organization_id = member.organization_id
          AND package.id = member.package_id
         JOIN operations_one_off_carrier_group_results result
           ON result.organization_id = member.organization_id
          AND result.carrier_group_attempt_id = member.carrier_group_attempt_id
          AND result.package_id = member.package_id
         JOIN operations_labels label
           ON label.organization_id = result.organization_id
          AND label.id = result.label_id
         LEFT JOIN LATERAL (
           SELECT job.global_id, job.status, job.last_error
           FROM operations_print_jobs job
           WHERE job.organization_id = label.organization_id
             AND job.label_id = label.id
           ORDER BY job.created_at DESC, job.id DESC
           LIMIT 1
         ) print_job ON true
         WHERE member.organization_id = $1::uuid
           AND member.carrier_group_attempt_id = $2::uuid
         ORDER BY member.package_number, member.id`,
        [organizationId, create.id],
      )
    : { rows: [] }
  const latestQuote = packedRateRows.rows[0]
  const persistedLifecycleMode = create?.state === 'succeeded'
    && create.master_tracking_number
    && create.provider_shipment_id
    && labels.rows.length === create.package_count
    ? carrierOneOffGroupLifecycleMode({
        provider: create.provider,
        environment: create.environment,
        masterTrackingNumber: create.master_tracking_number,
        providerShipmentId: create.provider_shipment_id,
        packageTrackingNumbers: labels.rows.map((label) => label.tracking_number),
      }) === 'close_sample'
      ? 'local_sample_close' as const
      : 'carrier_void' as const
    : null
  return {
    orderGlobalId,
    rowVersion: numberValue(context.row_version),
    executionMode: context.execution_mode,
    environment: context.environment,
    packageCount: packages.length,
    planning: {
      quoteGlobalId: context.planning_quote_global_id,
      offerGlobalId: context.planning_offer_global_id,
      provider: context.provider,
      serviceCode: context.service_code,
      serviceName: context.service_name,
      amountMinor: numberValue(context.planning_amount_minor),
      currency: context.currency,
    },
    packedRate: latestQuote ? {
      quoteGlobalId: latestQuote.quote_global_id,
      requestIdempotencyKey: latestQuote.idempotency_key,
      expiresAt: new Date(latestQuote.expires_at).toISOString(),
      status: latestQuote.status,
      consumed: latestQuote.consumed,
      offers: packedRateRows.rows.map((offer) => ({
        globalId: offer.offer_global_id,
        provider: offer.provider,
        providerLabel: oneOffProviderLabel(offer.provider),
        executionCapability: offer.provider === 'wwex_speedship'
          ? 'rate_only' as const
          : 'direct_purchase_later' as const,
        environment: offer.environment,
        serviceCode: offer.service_code,
        serviceName: offer.service_name,
        amountMinor: numberValue(offer.amount_minor),
        currency: offer.currency,
        transitDays: offer.transit_days,
        estimatedDeliveryAt: offer.estimated_delivery_at
          ? new Date(offer.estimated_delivery_at).toISOString()
          : null,
        rateEvidenceGlobalId: offer.rate_evidence_global_id,
        integrationAccountGlobalId: offer.integration_account_global_id,
        carrierAccountGlobalId: offer.carrier_account_global_id,
        credentialVersion: offer.credential_version,
      })),
    } : null,
    carrierGroup: create ? {
      createAttemptGlobalId: create.global_id,
      createRequestIdempotencyKey: create.create_idempotency_key,
      purchaseQuoteGlobalId: create.purchase_quote_global_id,
      purchaseOfferGlobalId: create.purchase_offer_global_id,
      state: create.state,
      provider: create.provider,
      serviceCode: create.service_code,
      packageCount: create.package_count,
      selectedAmountMinor: numberValue(create.selected_amount_minor),
      currency: create.currency,
      providerChargeMinor: create.provider_charge_minor === null
        ? null : numberValue(create.provider_charge_minor),
      providerChargeCurrency: create.provider_charge_currency,
      chargeVarianceMinor: create.charge_variance_minor === null
        ? null : numberValue(create.charge_variance_minor),
      masterTrackingNumber: create.master_tracking_number,
      providerShipmentId: create.provider_shipment_id,
      lifecycleMode: persistedLifecycleMode,
      unresolved: create.state === 'prepared' || create.state === 'unknown'
        || create.void_state === 'prepared' || create.void_state === 'unknown',
      active: create.state === 'succeeded'
        && create.void_state !== 'prepared'
        && create.void_state !== 'succeeded'
        && create.void_state !== 'unknown',
      voidAttemptGlobalId: create.void_global_id,
      voidRequestIdempotencyKey: create.void_idempotency_key,
      voidAction: create.void_action,
      voidState: create.void_state,
      labels: labels.rows.map((label) => ({
        packageGlobalId: label.package_global_id,
        packageNumber: label.package_number,
        labelGlobalId: label.label_global_id,
        trackingNumber: label.tracking_number,
        status: label.status,
        printJobGlobalId: label.print_job_global_id,
        printStatus: label.print_status,
        printWarning: label.print_warning,
      })),
    } : null,
  }
}

export async function refreshOperationsOneOffPackedRatesInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  orderGlobalId: string
  expectedRowVersion: number
}): Promise<OneOffPackedRateRefresh> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const orderGlobalId = requiredId(input.orderGlobalId, 'Order', ORDER_GLOBAL_ID)
  const expectedRowVersion = requiredVersion(input.expectedRowVersion)
  const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey)
  const context = await readGroupContext(organizationId, orderGlobalId, null, false)
  const [packages, lines] = await Promise.all([
    readPackedPackages(
      organizationId,
      context.plan_id,
      context.planning_quote_id,
    ),
    readPackedLines(organizationId, context.order_id),
  ])
  assertPackedContext(context, packages, expectedRowVersion)
  const quoted = await quoteOneOffShipmentInPostgres({
    organizationId,
    actorEmail: input.actorEmail,
    idempotencyKey,
    quote: quoteInput(context, lines, packages),
    inventoryReservationOrderGlobalId: orderGlobalId,
  })
  const offers = quoted.offers.filter((offer) => (
    offer.provider === context.provider
    && offer.environment === context.environment
    && offer.serviceCode === context.service_code
    && offer.integrationAccountGlobalId === context.integration_account_global_id
    && offer.carrierAccountGlobalId === context.carrier_account_global_id
    && offer.currency === context.currency
  ))
  if (!offers.length) {
    fail(
      'OPERATIONS_ONE_OFF_PACKED_RATE_UNAVAILABLE',
      `The packed shipment no longer has the planned ${oneOffProviderLabel(context.provider)} ${context.service_name} service on the exact carrier account; review carrier setup or create a new plan`,
    )
  }
  return {
    orderGlobalId,
    rowVersion: numberValue(context.row_version),
    planningQuoteGlobalId: context.planning_quote_global_id,
    planningOfferGlobalId: context.planning_offer_global_id,
    planningAmountMinor: numberValue(context.planning_amount_minor),
    currency: context.currency,
    executionMode: context.execution_mode,
    packageCount: packages.length,
    quote: { ...quoted, offers },
  }
}

type PurchaseAuthorityRow = QueryResultRow & {
  quote_id: string
  quote_global_id: string
  offer_id: string
  offer_global_id: string
  expires_at: Date
  amount_minor: string
  currency: string
  provider: Provider
  environment: Environment
  service_code: string
  service_name: string
  integration_account_id: string
  integration_account_global_id: string
  carrier_account_id: string
  carrier_account_global_id: string
  rate_evidence_global_id: string
}

async function readPurchaseAuthority(
  organizationId: string,
  context: GroupContext,
  quoteGlobalId: string,
  offerGlobalId: string,
  client: PoolClient | null,
  lock: boolean,
) {
  const result = await dbQuery<PurchaseAuthorityRow>(
    client,
    `SELECT purchase_quote.id::text AS quote_id,
            purchase_quote.global_id AS quote_global_id,
            purchase_offer.id::text AS offer_id,
            purchase_offer.global_id AS offer_global_id,
            purchase_quote.expires_at, purchase_offer.amount_minor::text,
            purchase_offer.currency, purchase_offer.provider,
            purchase_offer.environment, purchase_offer.service_code,
            purchase_offer.service_name,
            purchase_offer.integration_account_id::text,
            integration.global_id AS integration_account_global_id,
            purchase_offer.carrier_account_id::text,
            carrier_account.global_id AS carrier_account_global_id,
            purchase_offer.rate_evidence_global_id
     FROM operations_one_off_shipment_quotes purchase_quote
     JOIN operations_one_off_shipment_quote_offers purchase_offer
       ON purchase_offer.organization_id = purchase_quote.organization_id
      AND purchase_offer.quote_id = purchase_quote.id
     JOIN operations_integration_accounts integration
       ON integration.organization_id = purchase_offer.organization_id
      AND integration.id = purchase_offer.integration_account_id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = purchase_offer.organization_id
      AND carrier_account.integration_account_id = purchase_offer.integration_account_id
      AND carrier_account.id = purchase_offer.carrier_account_id
     WHERE purchase_quote.organization_id = $1::uuid
       AND purchase_quote.global_id = $2
       AND purchase_offer.global_id = $3
       AND operations_one_off_purchase_quote_is_valid(
         $1::uuid, $4::uuid, purchase_quote.id, purchase_offer.id
       )
     LIMIT 1
     ${lock ? 'FOR UPDATE OF purchase_quote' : ''}`,
    [organizationId, quoteGlobalId, offerGlobalId, context.plan_id],
  )
  if (!result.rows[0]) {
    fail(
      'OPERATIONS_ONE_OFF_PACKED_RATE_STALE',
      'Refresh packed rates and select the exact planned carrier service before purchasing the whole shipment',
    )
  }
  return result.rows[0]
}

async function resolveGroupCreateRuntime(input: {
  organizationId: string
  executionMode: OneOffExecutionMode
  purchase: PurchaseAuthorityRow
}) {
  return input.executionMode === 'live'
    ? resolveCarrierProductionShippingRuntime({
        organizationId: input.organizationId,
        provider: input.purchase.provider,
        integrationAccountGlobalId: input.purchase.integration_account_global_id,
        carrierAccountGlobalId: input.purchase.carrier_account_global_id,
      })
    : resolveCarrierSandboxShippingRuntime({
        organizationId: input.organizationId,
        provider: input.purchase.provider,
        carrierAccountGlobalId: input.purchase.carrier_account_global_id,
        senderBillingOnly: true,
      })
}

function assertPurchaseRuntimeBinding(
  purchase: PurchaseAuthorityRow,
  runtime: Awaited<ReturnType<typeof resolveGroupCreateRuntime>>,
) {
  if (
    runtime.integrationAccountId !== purchase.integration_account_id
    || runtime.carrierAccountId !== purchase.carrier_account_id
    || runtime.provider !== purchase.provider
    || runtime.environment !== purchase.environment
  ) {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_CARRIER_BINDING_CHANGED',
      'The fresh packed rate no longer matches the exact carrier credential and account',
    )
  }
}

function groupRuntime(
  runtime: Awaited<ReturnType<typeof resolveCarrierSandboxShippingRuntime>>
    | Awaited<ReturnType<typeof resolveCarrierProductionShippingRuntime>>
    | Awaited<ReturnType<typeof resolveCarrierOneOffVoidRuntime>>,
): CarrierOneOffGroupRuntime {
  const billingSelectionSnapshot = 'billingSelectionSnapshot' in runtime
    ? runtime.billingSelectionSnapshot
    : {
        mode: 'verified_production_sender',
        integrationAccountGlobalId: runtime.integrationGlobalId,
        carrierAccountGlobalId: runtime.carrierAccountGlobalId,
        accountNumberLastFour: runtime.accountNumberLastFour,
        registeredAddressFingerprint: runtime.registeredAddressFingerprint,
      }
  return {
    provider: runtime.provider,
    environment: runtime.environment,
    credential: runtime.credential,
    integrationAccountGlobalId: runtime.integrationGlobalId,
    carrierAccountGlobalId: runtime.carrierAccountGlobalId,
    credentialVersion: runtime.credentialVersion,
    credentialFingerprint: runtime.credentialFingerprint,
    accountNumberFingerprint: runtime.accountNumberFingerprint,
    billingRelationship: runtime.billingRelationship,
    billingSelectionSnapshot,
  }
}

function groupFixture(
  context: GroupContext,
  packages: PackedPackageRow[],
): CarrierOneOffGroupShipmentFixture {
  return {
    origin: addressParty(context.warehouse_address, 'Warehouse'),
    destination: {
      ...addressParty(context.destination_snapshot, 'Recipient'),
      residential: context.destination_snapshot.residential === true,
    },
    parcels: packages.map((item) => ({
      packageKey: item.quote_package_key,
      packageNumber: item.package_number,
      description: `ClawPilot one-off ${context.order_number} parcel ${item.package_number}`,
      length: Math.max(0.01, Number((item.length_mm / 25.4).toFixed(3))),
      width: Math.max(0.01, Number((item.width_mm / 25.4).toFixed(3))),
      height: Math.max(0.01, Number((item.height_mm / 25.4).toFixed(3))),
      dimensionUnit: 'IN' as const,
      weight: Math.max(0.01, Number((item.weight_grams / 453.59237).toFixed(3))),
      weightUnit: 'LB' as const,
    })),
  }
}

function allocateSelectedCost(total: number, packages: PackedPackageRow[]) {
  const totalWeight = packages.reduce((sum, item) => sum + item.weight_grams, 0)
  let allocated = 0
  return packages.map((item, index) => {
    const value = index === packages.length - 1
      ? total - allocated
      : Math.floor(total * item.weight_grams / totalWeight)
    allocated += value
    return value
  })
}

type GroupAttemptRow = QueryResultRow & {
  id: string
  global_id: string
  action: 'create' | 'void' | 'close_sample'
  state: GroupState
  request_hash: string
  redacted_request: JsonObject
  redacted_response: JsonObject
  provider_reference: string | null
  master_tracking_number: string | null
  provider_shipment_id: string | null
  selected_amount_minor: string
  currency: string
  provider_charge_minor: string | null
  provider_charge_currency: string | null
  charge_variance_minor: string | null
  package_count: number
  environment: Environment
  provider: Provider
  service_code: string
  error_code: string | null
}

type CreateReplayRow = GroupAttemptRow & {
  order_id: string
  purchase_quote_global_id: string
  purchase_offer_global_id: string
  reason: string
}

async function readCreateReplay(
  organizationId: string,
  idempotencyKey: string,
  client: PoolClient | null = null,
  lock = false,
) {
  const result = await dbQuery<CreateReplayRow>(
    client,
    `SELECT attempt.id::text, attempt.global_id, attempt.action,
            attempt.state, attempt.request_hash, attempt.redacted_request,
            attempt.redacted_response, attempt.provider_reference,
            attempt.master_tracking_number, attempt.provider_shipment_id,
            attempt.selected_amount_minor::text, attempt.currency,
            attempt.provider_charge_minor::text,
            attempt.provider_charge_currency,
            attempt.charge_variance_minor::text, attempt.package_count,
            attempt.environment, attempt.provider, attempt.service_code,
            attempt.error_code, attempt.order_id::text,
            purchase_quote.global_id AS purchase_quote_global_id,
            purchase_offer.global_id AS purchase_offer_global_id,
            attempt.reason
     FROM operations_one_off_carrier_group_attempts attempt
     JOIN operations_one_off_shipment_quotes purchase_quote
       ON purchase_quote.organization_id = attempt.organization_id
      AND purchase_quote.id = attempt.purchase_quote_id
     JOIN operations_one_off_shipment_quote_offers purchase_offer
       ON purchase_offer.organization_id = attempt.organization_id
      AND purchase_offer.quote_id = attempt.purchase_quote_id
      AND purchase_offer.id = attempt.purchase_offer_id
     WHERE attempt.organization_id = $1::uuid
       AND attempt.action = 'create'
       AND attempt.idempotency_key = $2
     LIMIT 1
     ${lock ? 'FOR UPDATE OF attempt' : ''}`,
    [organizationId, idempotencyKey],
  )
  return result.rows[0] || null
}

function assertCreateReplayRequest(input: {
  attempt: CreateReplayRow
  orderId: string
  quoteGlobalId: string
  offerGlobalId: string
  reason: string
}) {
  if (
    input.attempt.order_id !== input.orderId
    || input.attempt.purchase_quote_global_id !== input.quoteGlobalId
    || input.attempt.purchase_offer_global_id !== input.offerGlobalId
    || input.attempt.reason !== input.reason
  ) {
    fail(
      'OPERATIONS_IDEMPOTENCY_CONFLICT',
      'This Idempotency-Key is already bound to another whole-shipment purchase',
    )
  }
  if (input.attempt.state !== 'succeeded') {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
      `Carrier group attempt ${input.attempt.global_id} is ${input.attempt.state}; reconcile it before another provider call`,
    )
  }
  if (!input.attempt.master_tracking_number || !input.attempt.provider_shipment_id) {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
      'The completed carrier group is missing immutable provider shipment evidence',
    )
  }
}

type ResultLabelRow = QueryResultRow & {
  package_global_id: string
  package_number: number
  label_global_id: string
  tracking_number: string
  status: 'created' | 'voided'
}

async function readResultLabels(
  organizationId: string,
  createAttemptId: string,
  client: PoolClient | null = null,
) {
  const result = await dbQuery<ResultLabelRow>(
    client,
    `SELECT package.global_id AS package_global_id,
            member.package_number, label.global_id AS label_global_id,
            label.tracking_number, label.status
     FROM operations_one_off_carrier_group_members member
     JOIN operations_packages package
       ON package.organization_id = member.organization_id
      AND package.id = member.package_id
     JOIN operations_one_off_carrier_group_results group_result
       ON group_result.organization_id = member.organization_id
      AND group_result.carrier_group_attempt_id = member.carrier_group_attempt_id
      AND group_result.package_id = member.package_id
     JOIN operations_labels label
       ON label.organization_id = group_result.organization_id
      AND label.id = group_result.label_id
     WHERE member.organization_id = $1::uuid
       AND member.carrier_group_attempt_id = $2::uuid
     ORDER BY member.package_number, member.id`,
    [organizationId, createAttemptId],
  )
  return result.rows
}

async function enqueueGroupPrints(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  warehouseId: string
  preferredPrinterGlobalId: string | null
  labels: ResultLabelRow[]
}) {
  return Promise.all(input.labels.map(async (label) => {
    try {
      const job = await enqueueOperationsPrintJobInPostgres({
        organizationId: input.organizationId,
        actorEmail: input.actorEmail,
        idempotencyKey: `${input.idempotencyKey}:print:${label.package_number}`,
        warehouseId: input.warehouseId,
        preferredPrinterGlobalId: input.preferredPrinterGlobalId,
        document: {
          type: 'shipping_label',
          sourceLabelGlobalId: label.label_global_id,
          media: 'label_4x6',
        },
      })
      return {
        packageGlobalId: label.package_global_id,
        packageNumber: label.package_number,
        labelGlobalId: label.label_global_id,
        trackingNumber: label.tracking_number,
        status: label.status,
        printJobGlobalId: job.globalId,
        printWarning: null,
      }
    } catch (error) {
      return {
        packageGlobalId: label.package_global_id,
        packageNumber: label.package_number,
        labelGlobalId: label.label_global_id,
        trackingNumber: label.tracking_number,
        status: label.status,
        printJobGlobalId: null,
        printWarning: error instanceof Error
          ? error.message
          : 'Label was created, but printer routing failed',
      }
    }
  }))
}

async function replayCreatedGroup(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  preferredPrinterGlobalId: string | null
  orderGlobalId: string
  context: GroupContext
  attempt: CreateReplayRow
}): Promise<OneOffCarrierGroupCommandResult> {
  const labels = await readResultLabels(
    input.organizationId,
    input.attempt.id,
  )
  const createdLabels = labels.filter((label) => label.status === 'created')
  const printed = createdLabels.length
    ? await enqueueGroupPrints({
        organizationId: input.organizationId,
        actorEmail: input.actorEmail,
        idempotencyKey: input.idempotencyKey,
        warehouseId: input.context.warehouse_id,
        preferredPrinterGlobalId: input.preferredPrinterGlobalId,
        labels: createdLabels,
      })
    : []
  const printedByLabel = new Map(printed.map((label) => [label.labelGlobalId, label]))
  return {
    orderGlobalId: input.orderGlobalId,
    orderStatus: 'packed',
    rowVersion: numberValue(input.context.row_version),
    groupAttemptGlobalId: input.attempt.global_id,
    action: 'create',
    state: 'succeeded',
    executionMode: input.context.execution_mode,
    environment: input.attempt.environment,
    provider: input.attempt.provider,
    serviceCode: input.attempt.service_code,
    packageCount: input.attempt.package_count,
    masterTrackingNumber: input.attempt.master_tracking_number!,
    providerShipmentId: input.attempt.provider_shipment_id!,
    selectedAmountMinor: numberValue(input.attempt.selected_amount_minor),
    currency: input.attempt.currency,
    providerChargeMinor: input.attempt.provider_charge_minor === null
      ? null : numberValue(input.attempt.provider_charge_minor),
    providerChargeCurrency: input.attempt.provider_charge_currency,
    chargeVarianceMinor: input.attempt.charge_variance_minor === null
      ? null : numberValue(input.attempt.charge_variance_minor),
    labels: labels.map((label) => printedByLabel.get(label.label_global_id) || ({
      packageGlobalId: label.package_global_id,
      packageNumber: label.package_number,
      labelGlobalId: label.label_global_id,
      trackingNumber: label.tracking_number,
      status: label.status,
      printJobGlobalId: null,
      printWarning: null,
    })),
    replayed: true,
  }
}

function terminalCarrierError(error: unknown) {
  if (error instanceof CarrierOneOffGroupError) return error
  if (error instanceof CarrierIntegrationRequestError) {
    return new CarrierOneOffGroupError(
      error.message,
      error.status,
      error.code,
      false,
    )
  }
  return new CarrierOneOffGroupError(
    'The carrier shipment result is unknown and requires reconciliation',
    503,
    'CARRIER_PROVIDER_RESULT_UNKNOWN',
    true,
  )
}

async function finalizeAttemptFailure(input: {
  organizationId: string
  attemptId: string
  error: CarrierOneOffGroupError
}) {
  await query(
    `UPDATE operations_one_off_carrier_group_attempts
     SET state = $3, redacted_response = $4::jsonb,
         provider_reference = NULL, error_code = $5,
         completed_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid
       AND state = 'prepared'`,
    [
      input.organizationId,
      input.attemptId,
      input.error.uncertain ? 'unknown' : 'failed',
      JSON.stringify(input.error.redactedResponse || {}),
      input.error.code,
    ],
  )
}

async function appendGroupEvent(client: PoolClient, input: {
  organizationId: string
  orderId: string
  orderGlobalId: string
  actorEmail: string
  eventType: 'label.created' | 'label.voided'
  idempotencyKey: string
  payload: JsonObject
}) {
  await client.query(
    `INSERT INTO operations_domain_events (
       organization_id, aggregate_type, aggregate_id, aggregate_global_id,
       event_type, payload, actor_email, correlation_id, idempotency_key
     ) VALUES (
       $1::uuid, 'operations.order', $2::uuid, $3,
       $4, $5::jsonb, $6, $7::uuid, $8
     ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
    [
      input.organizationId,
      input.orderId,
      input.orderGlobalId,
      input.eventType,
      JSON.stringify(input.payload),
      input.actorEmail,
      randomUUID(),
      input.idempotencyKey,
    ],
  )
}

export async function createOperationsOneOffCarrierGroupInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  orderGlobalId: string
  purchaseQuoteGlobalId: string
  selectedOfferGlobalId: string
  expectedRowVersion: number
  reason: string
  preferredPrinterGlobalId?: string | null
}): Promise<OneOffCarrierGroupCommandResult> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredText(input.actorEmail, 'Actor', 320).toLowerCase()
  const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey)
  const orderGlobalId = requiredId(input.orderGlobalId, 'Order', ORDER_GLOBAL_ID)
  const quoteGlobalId = requiredId(
    input.purchaseQuoteGlobalId,
    'Packed rate quote',
    QUOTE_GLOBAL_ID,
  )
  const offerGlobalId = requiredId(
    input.selectedOfferGlobalId,
    'Packed rate offer',
    OFFER_GLOBAL_ID,
  )
  const expectedRowVersion = requiredVersion(input.expectedRowVersion)
  const reason = requiredText(input.reason, 'Postage purchase reason', 500)
  const preferredPrinterGlobalId = optionalPrinter(input.preferredPrinterGlobalId)

  const initial = await readGroupContext(organizationId, orderGlobalId, null, false)
  const replay = await readCreateReplay(organizationId, idempotencyKey)
  if (replay) {
    assertCreateReplayRequest({
      attempt: replay,
      orderId: initial.order_id,
      quoteGlobalId,
      offerGlobalId,
      reason,
    })
    return replayCreatedGroup({
      organizationId,
      actorEmail,
      idempotencyKey,
      preferredPrinterGlobalId,
      orderGlobalId,
      context: initial,
      attempt: replay,
    })
  }
  const [packages, purchase] = await Promise.all([
    readPackedPackages(
      organizationId,
      initial.plan_id,
      initial.planning_quote_id,
    ),
    readPurchaseAuthority(
      organizationId,
      initial,
      quoteGlobalId,
      offerGlobalId,
      null,
      false,
    ),
  ])
  assertPackedContext(initial, packages, expectedRowVersion)
  const runtimeSource = await resolveGroupCreateRuntime({
    organizationId,
    executionMode: initial.execution_mode,
    purchase,
  })
  assertPurchaseRuntimeBinding(purchase, runtimeSource)
  const runtime = groupRuntime(runtimeSource)
  const attemptCorrelationKey = `oneoff_group_${oneOffShipmentHash({
    organizationId,
    orderGlobalId,
    idempotencyKey,
  }).slice(0, 48)}`
  const shipDate = new Date().toISOString().slice(0, 10)
  const preparedRequest = prepareCarrierOneOffGroupRequest({
    runtime,
    serviceCode: purchase.service_code,
    shipmentFixture: groupFixture(initial, packages),
    outputFormat: 'ZPL',
    shipFromPhone: String(initial.destination_snapshot.shipFromPhone || ''),
    shipToPhone: String(initial.destination_snapshot.phone || ''),
    shipDate,
    attemptCorrelationKey,
  })

  const prepared = await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:one-off-carrier-group:${organizationId}:${orderGlobalId}`,
    )
    const context = await readGroupContext(
      organizationId,
      orderGlobalId,
      client,
      true,
    )
    const racedReplay = await readCreateReplay(
      organizationId,
      idempotencyKey,
      client,
      true,
    )
    if (racedReplay) {
      assertCreateReplayRequest({
        attempt: racedReplay,
        orderId: context.order_id,
        quoteGlobalId,
        offerGlobalId,
        reason,
      })
      return {
        context,
        attempt: racedReplay,
        replayed: true as const,
      }
    }
    const lockedPackages = await readPackedPackages(
      organizationId,
      context.plan_id,
      context.planning_quote_id,
      client,
      true,
    )
    assertPackedContext(context, lockedPackages, expectedRowVersion)
    const lockedPurchase = await readPurchaseAuthority(
      organizationId,
      context,
      quoteGlobalId,
      offerGlobalId,
      client,
      true,
    )
    const lockedPreparedRequest = prepareCarrierOneOffGroupRequest({
      runtime,
      serviceCode: lockedPurchase.service_code,
      shipmentFixture: groupFixture(context, lockedPackages),
      outputFormat: 'ZPL',
      shipFromPhone: String(context.destination_snapshot.shipFromPhone || ''),
      shipToPhone: String(context.destination_snapshot.phone || ''),
      shipDate,
      attemptCorrelationKey,
    })
    if (
      lockedPurchase.integration_account_id !== runtimeSource.integrationAccountId
      || lockedPurchase.carrier_account_id !== runtimeSource.carrierAccountId
      || lockedPurchase.provider !== runtime.provider
      || lockedPurchase.environment !== runtime.environment
      || lockedPurchase.service_code !== preparedRequest.serviceCode
      || lockedPurchase.amount_minor !== purchase.amount_minor
      || lockedPurchase.currency !== purchase.currency
      || lockedPreparedRequest.requestHash !== preparedRequest.requestHash
    ) {
      fail(
        'OPERATIONS_ONE_OFF_GROUP_CARRIER_BINDING_CHANGED',
        'The packed shipment or carrier authority changed before durable prepare',
      )
    }
    const attempt = await client.query<GroupAttemptRow>(
      `INSERT INTO operations_one_off_carrier_group_attempts (
         organization_id, order_id, plan_id,
         planning_quote_id, planning_offer_id,
         purchase_quote_id, purchase_offer_id, carrier_rate_id,
         integration_account_id, carrier_account_id,
         action, environment, provider, service_code, package_count,
         selected_amount_minor, currency, adapter_version,
         idempotency_key, request_hash, redacted_request,
         reason, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
         'create', $11, $12, $13, $14, $15, $16, $17,
         $18, $19, $20::jsonb, $21, $22
       )
       RETURNING id::text, global_id, action, state, request_hash,
                 redacted_request, redacted_response, provider_reference,
                 master_tracking_number, provider_shipment_id,
                 selected_amount_minor::text, currency,
                 provider_charge_minor::text, provider_charge_currency,
                 charge_variance_minor::text, package_count, environment,
                 provider, service_code, error_code`,
      [
        organizationId,
        context.order_id,
        context.plan_id,
        context.planning_quote_id,
        context.planning_offer_id,
        lockedPurchase.quote_id,
        lockedPurchase.offer_id,
        context.carrier_rate_id,
        runtimeSource.integrationAccountId,
        runtimeSource.carrierAccountId,
        lockedPurchase.environment,
        lockedPurchase.provider,
        lockedPurchase.service_code,
        lockedPackages.length,
        lockedPurchase.amount_minor,
        lockedPurchase.currency,
        CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
        idempotencyKey,
        preparedRequest.requestHash,
        JSON.stringify(preparedRequest.redactedRequest),
        reason,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_one_off_purchase_quote_consumptions (
         organization_id, quote_id, offer_id, order_id, plan_id,
         carrier_group_attempt_id, reason, consumed_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7, $8
       )`,
      [
        organizationId,
        lockedPurchase.quote_id,
        lockedPurchase.offer_id,
        context.order_id,
        context.plan_id,
        attempt.rows[0].id,
        reason,
        actorEmail,
      ],
    )
    const lockedAllocations = allocateSelectedCost(
      numberValue(lockedPurchase.amount_minor),
      lockedPackages,
    )
    for (const [index, parcel] of lockedPackages.entries()) {
      await client.query(
        `INSERT INTO operations_one_off_carrier_group_members (
           organization_id, carrier_group_attempt_id, order_id, plan_id,
           package_id, package_number, quote_package_key,
           length_mm, width_mm, height_mm, weight_grams,
           allocated_selected_cost_minor, parcel_snapshot_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6, $7, $8, $9, $10, $11, $12,
           operations_one_off_package_snapshot_hash(
             $1::uuid, $4::uuid, $5::uuid, $13::uuid
           )
         )`,
        [
          organizationId,
          attempt.rows[0].id,
          context.order_id,
          context.plan_id,
          parcel.id,
          parcel.package_number,
          parcel.quote_package_key,
          parcel.length_mm,
          parcel.width_mm,
          parcel.height_mm,
          parcel.weight_grams,
          lockedAllocations[index],
          lockedPurchase.quote_id,
        ],
      )
    }
    return { context, attempt: attempt.rows[0], replayed: false as const }
  })

  if (prepared.replayed) {
    const labels = await readResultLabels(
      organizationId,
      prepared.attempt.id,
    )
    const printed = await enqueueGroupPrints({
      organizationId,
      actorEmail,
      idempotencyKey,
      warehouseId: prepared.context.warehouse_id,
      preferredPrinterGlobalId,
      labels,
    })
    return {
      orderGlobalId,
      orderStatus: 'packed',
      rowVersion: numberValue(prepared.context.row_version),
      groupAttemptGlobalId: prepared.attempt.global_id,
      action: 'create',
      state: 'succeeded',
      executionMode: prepared.context.execution_mode,
      environment: prepared.attempt.environment,
      provider: prepared.attempt.provider,
      serviceCode: prepared.attempt.service_code,
      packageCount: prepared.attempt.package_count,
      masterTrackingNumber: prepared.attempt.master_tracking_number!,
      providerShipmentId: prepared.attempt.provider_shipment_id!,
      selectedAmountMinor: numberValue(prepared.attempt.selected_amount_minor),
      currency: prepared.attempt.currency,
      providerChargeMinor: prepared.attempt.provider_charge_minor === null
        ? null : numberValue(prepared.attempt.provider_charge_minor),
      providerChargeCurrency: prepared.attempt.provider_charge_currency,
      chargeVarianceMinor: prepared.attempt.charge_variance_minor === null
        ? null : numberValue(prepared.attempt.charge_variance_minor),
      labels: printed,
      replayed: true,
    }
  }

  // The quote expiry is checked again after durable prepare and immediately
  // before any credential token or provider request. Expiry is a known
  // no-call failure, so a new packed rerate can be requested safely.
  const quoteWindow = await query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_one_off_carrier_group_attempts attempt
       JOIN operations_one_off_shipment_quotes purchase_quote
         ON purchase_quote.organization_id = attempt.organization_id
        AND purchase_quote.id = attempt.purchase_quote_id
       WHERE attempt.organization_id = $1::uuid AND attempt.id = $2::uuid
         AND attempt.state = 'prepared'
         AND purchase_quote.expires_at > clock_timestamp()
     ) AS current`,
    [organizationId, prepared.attempt.id],
  )
  const executable = await query<{ valid: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_one_off_carrier_group_attempts attempt
       JOIN operations_one_off_shipment_quotes purchase_quote
         ON purchase_quote.organization_id = attempt.organization_id
        AND purchase_quote.id = attempt.purchase_quote_id
       JOIN operations_one_off_shipment_quote_offers purchase_offer
         ON purchase_offer.organization_id = purchase_quote.organization_id
        AND purchase_offer.quote_id = purchase_quote.id
        AND purchase_offer.id = attempt.purchase_offer_id
       JOIN operations_one_off_purchase_quote_consumptions consumption
         ON consumption.organization_id = attempt.organization_id
        AND consumption.quote_id = attempt.purchase_quote_id
        AND consumption.offer_id = attempt.purchase_offer_id
        AND consumption.order_id = attempt.order_id
        AND consumption.plan_id = attempt.plan_id
        AND consumption.carrier_group_attempt_id = attempt.id
       WHERE attempt.organization_id = $1::uuid AND attempt.id = $2::uuid
         AND attempt.state = 'prepared'
         AND purchase_quote.expires_at > clock_timestamp()
         AND purchase_offer.provider = attempt.provider
         AND purchase_offer.environment = attempt.environment
         AND purchase_offer.service_code = attempt.service_code
         AND purchase_offer.integration_account_id = attempt.integration_account_id
         AND purchase_offer.carrier_account_id = attempt.carrier_account_id
         AND purchase_offer.amount_minor = attempt.selected_amount_minor
         AND purchase_offer.currency = attempt.currency
         AND operations_one_off_plan_execution_is_exact(
           attempt.organization_id, attempt.plan_id,
           CASE WHEN attempt.environment = 'production' THEN 'live' ELSE 'test' END
         )
         AND (
           SELECT count(*)
           FROM operations_one_off_carrier_group_members member
           WHERE member.organization_id = attempt.organization_id
             AND member.carrier_group_attempt_id = attempt.id
         ) = attempt.package_count
         AND NOT EXISTS (
           SELECT 1
           FROM operations_one_off_carrier_group_members member
           JOIN operations_packages package
             ON package.organization_id = member.organization_id
            AND package.id = member.package_id
            AND package.plan_id = member.plan_id
           WHERE member.organization_id = attempt.organization_id
             AND member.carrier_group_attempt_id = attempt.id
             AND (
               package.status <> 'packed'
               OR package.package_number IS DISTINCT FROM member.package_number
               OR member.parcel_snapshot_hash IS DISTINCT FROM
                 operations_one_off_package_snapshot_hash(
                   member.organization_id, member.plan_id, member.package_id,
                   attempt.purchase_quote_id
                 )
               OR EXISTS (
                 SELECT 1 FROM operations_labels competing_label
                 WHERE competing_label.organization_id = member.organization_id
                   AND competing_label.package_id = member.package_id
                   AND competing_label.status = 'created'
               )
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM operations_shipments shipment
           WHERE shipment.organization_id = attempt.organization_id
             AND shipment.order_id = attempt.order_id
         )
     ) AS valid`,
    [organizationId, prepared.attempt.id],
  )
  if (!executable.rows[0]?.valid) {
    const expired = quoteWindow.rows[0]?.current !== true
    const fenced = new CarrierOneOffGroupError(
      expired
        ? 'The packed carrier rate expired before purchase; refresh rates before trying again'
        : 'The activation, carrier authority, or canonical packed package set changed before purchase; no carrier call was made',
      409,
      expired
        ? 'OPERATIONS_ONE_OFF_PACKED_RATE_EXPIRED'
        : 'OPERATIONS_ONE_OFF_GROUP_PRECALL_FENCE_FAILED',
      false,
      { carrierCallMade: false },
    )
    await finalizeAttemptFailure({
      organizationId,
      attemptId: prepared.attempt.id,
      error: fenced,
    })
    throw new OneOffShipmentPersistenceError(
      fenced.code,
      fenced.message,
      fenced.status,
    )
  }

  let providerResult: CarrierOneOffGroupShipmentResult
  try {
    const freshRuntimeSource = await resolveGroupCreateRuntime({
      organizationId,
      executionMode: prepared.context.execution_mode,
      purchase,
    })
    providerResult = await executeCarrierOneOffGroupShipment({
      runtime: groupRuntime(freshRuntimeSource),
      prepared: preparedRequest,
    })
  } catch (error) {
    const carrierError = terminalCarrierError(error)
    await finalizeAttemptFailure({
      organizationId,
      attemptId: prepared.attempt.id,
      error: carrierError,
    })
    throw new OneOffShipmentPersistenceError(
      carrierError.code,
      carrierError.message,
      carrierError.status,
    )
  }

  let finalized: {
    attempt: GroupAttemptRow
    rowVersion: number
    labels: ResultLabelRow[]
  }
  try {
    finalized = await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:one-off-carrier-group:${organizationId}:${orderGlobalId}`,
      )
      const attempt = await client.query<GroupAttemptRow>(
        `SELECT id::text, global_id, action, state, request_hash,
                redacted_request, redacted_response, provider_reference,
                master_tracking_number, provider_shipment_id,
                selected_amount_minor::text, currency,
                provider_charge_minor::text, provider_charge_currency,
                charge_variance_minor::text, package_count, environment,
                provider, service_code, error_code
         FROM operations_one_off_carrier_group_attempts
         WHERE organization_id = $1::uuid AND id = $2::uuid
         LIMIT 1 FOR UPDATE`,
        [organizationId, prepared.attempt.id],
      )
      if (
        !attempt.rows[0]
        || attempt.rows[0].state !== 'prepared'
        || attempt.rows[0].request_hash !== providerResult.evidence.requestHash
      ) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'The durable carrier group changed before complete label materialization',
        )
      }
      const members = await client.query<PackedPackageRow & {
        quote_package_key: string
        member_snapshot_hash: string
        current_snapshot_hash: string | null
      }>(
        `SELECT package.id::text, package.global_id, member.package_number,
                package.status, member.length_mm, member.width_mm,
                member.height_mm, member.weight_grams,
                member.quote_package_key, member.parcel_snapshot_hash
                  AS member_snapshot_hash,
                operations_one_off_package_snapshot_hash(
                  member.organization_id, member.plan_id, member.package_id,
                  attempt.purchase_quote_id
                ) AS current_snapshot_hash,
                '[]'::jsonb AS allocations
         FROM operations_one_off_carrier_group_members member
         JOIN operations_one_off_carrier_group_attempts attempt
           ON attempt.organization_id = member.organization_id
          AND attempt.id = member.carrier_group_attempt_id
         JOIN operations_packages package
           ON package.organization_id = member.organization_id
          AND package.id = member.package_id
         WHERE member.organization_id = $1::uuid
           AND member.carrier_group_attempt_id = $2::uuid
         ORDER BY member.package_number, member.id
         FOR UPDATE OF package`,
        [organizationId, attempt.rows[0].id],
      )
      const labelByKey = new Map(
        providerResult.labels.map((label) => [label.packageKey, label]),
      )
      if (
        members.rows.length !== providerResult.labels.length
        || members.rows.some((member) => (
          member.status !== 'packed'
          || member.current_snapshot_hash !== member.member_snapshot_hash
          || !labelByKey.has(member.quote_package_key)
        ))
      ) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'The carrier result did not cover the complete canonical package set',
        )
      }
      const competingLabels = await client.query<{ count: string }>(
        `SELECT count(*)::text
         FROM operations_labels label
         JOIN operations_one_off_carrier_group_members member
           ON member.organization_id = label.organization_id
          AND member.package_id = label.package_id
         WHERE member.organization_id = $1::uuid
           AND member.carrier_group_attempt_id = $2::uuid
           AND label.status = 'created'`,
        [organizationId, attempt.rows[0].id],
      )
      if (numberValue(competingLabels.rows[0]?.count || 0) !== 0) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'A competing active label appeared before carrier-group materialization',
        )
      }
      for (const member of members.rows) {
        const providerLabel = labelByKey.get(member.quote_package_key)!
        const label = await client.query<{ id: string; global_id: string }>(
          `INSERT INTO operations_labels (
             organization_id, package_id, carrier_rate_id,
             integration_account_id, carrier_account_id,
             carrier, service_code, tracking_number, format, label_payload,
             provider_label_id, idempotency_key, status, environment,
             request_hash, redacted_provider_evidence,
             one_off_carrier_group_attempt_id
           )
           SELECT attempt.organization_id, $3::uuid, attempt.carrier_rate_id,
                  attempt.integration_account_id, attempt.carrier_account_id,
                  $4, attempt.service_code, $5, $6, $7, $8, $9,
                  'created', attempt.environment, attempt.request_hash,
                  $10::jsonb, attempt.id
           FROM operations_one_off_carrier_group_attempts attempt
           WHERE attempt.organization_id = $1::uuid AND attempt.id = $2::uuid
           RETURNING id::text, global_id`,
          [
            organizationId,
            attempt.rows[0].id,
            member.id,
            oneOffProviderLabel(attempt.rows[0].provider),
            providerLabel.trackingNumber,
            providerLabel.format,
            providerLabel.labelPayload,
            providerLabel.providerLabelId,
            `${idempotencyKey}:label:${member.package_number}`,
            JSON.stringify({
              adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
              provider: attempt.rows[0].provider,
              groupRequest: providerResult.evidence.redactedRequest,
              groupResponse: providerResult.evidence.redactedResponse,
              package: {
                packageKey: providerLabel.packageKey,
                packageNumber: providerLabel.packageNumber,
                providerPackageReference: providerLabel.providerPackageReference,
                labelContentSha256: providerLabel.labelContentSha256,
                labelByteLength: providerLabel.labelByteLength,
              },
            }),
          ],
        )
        await client.query(
          `INSERT INTO operations_one_off_carrier_group_results (
             organization_id, carrier_group_attempt_id, package_id,
             package_number, label_id, tracking_number,
             provider_package_reference, redacted_provider_evidence
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::jsonb
           )`,
          [
            organizationId,
            attempt.rows[0].id,
            member.id,
            member.package_number,
            label.rows[0].id,
            providerLabel.trackingNumber,
            providerLabel.providerPackageReference,
            JSON.stringify({
              labelGlobalId: label.rows[0].global_id,
              contentSha256: providerLabel.labelContentSha256,
              byteLength: providerLabel.labelByteLength,
            }),
          ],
        )
      }
      const labeledPackages = await client.query<{ id: string }>(
        `UPDATE operations_packages package
         SET status = 'labeled'
         FROM operations_one_off_carrier_group_members member
         WHERE member.organization_id = $1::uuid
           AND member.carrier_group_attempt_id = $2::uuid
           AND package.organization_id = member.organization_id
           AND package.id = member.package_id
           AND package.status = 'packed'
         RETURNING package.id::text`,
        [organizationId, attempt.rows[0].id],
      )
      if (labeledPackages.rows.length !== attempt.rows[0].package_count) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'Every canonical package must remain packed until complete label materialization',
        )
      }
      const returnedCharge = providerResult.quotedCharge
      const variance = returnedCharge?.currency === attempt.rows[0].currency
        ? returnedCharge.amountMinor - numberValue(attempt.rows[0].selected_amount_minor)
        : null
      const updatedAttempt = await client.query<GroupAttemptRow>(
        `UPDATE operations_one_off_carrier_group_attempts
         SET state = 'succeeded', redacted_response = $3::jsonb,
             provider_reference = $4, provider_shipment_id = $5,
             master_tracking_number = $6,
             provider_charge_minor = $7,
             provider_charge_currency = $8,
             charge_variance_minor = $9,
             completed_at = $10::timestamptz
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND state = 'prepared'
         RETURNING id::text, global_id, action, state, request_hash,
                   redacted_request, redacted_response, provider_reference,
                   master_tracking_number, provider_shipment_id,
                   selected_amount_minor::text, currency,
                   provider_charge_minor::text, provider_charge_currency,
                   charge_variance_minor::text, package_count, environment,
                   provider, service_code, error_code`,
        [
          organizationId,
          attempt.rows[0].id,
          JSON.stringify(providerResult.evidence.redactedResponse),
          providerResult.evidence.providerReference,
          providerResult.providerShipmentId,
          providerResult.masterTrackingNumber,
          returnedCharge?.amountMinor ?? null,
          returnedCharge?.currency ?? null,
          variance,
          providerResult.evidence.completedAt,
        ],
      )
      if (!updatedAttempt.rows[0]) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'The carrier group could not be finalized exactly once',
        )
      }
      const order = await client.query<{ row_version: string }>(
        `UPDATE operations_orders
         SET row_version = row_version + 1, updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND status = 'packed'
         RETURNING row_version::text`,
        [organizationId, prepared.context.order_id, actorEmail],
      )
      if (!order.rows[0]) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'The order changed before complete label materialization',
        )
      }
      const eventPayload = {
        groupAttemptGlobalId: updatedAttempt.rows[0].global_id,
        purchaseQuoteGlobalId: quoteGlobalId,
        purchaseOfferGlobalId: offerGlobalId,
        planningQuoteGlobalId: prepared.context.planning_quote_global_id,
        planningOfferGlobalId: prepared.context.planning_offer_global_id,
        packageCount: members.rows.length,
        masterTrackingNumber: providerResult.masterTrackingNumber,
        providerShipmentId: providerResult.providerShipmentId,
        selectedAmountMinor: numberValue(attempt.rows[0].selected_amount_minor),
        currency: attempt.rows[0].currency,
        providerChargeMinor: returnedCharge?.amountMinor ?? null,
        providerChargeCurrency: returnedCharge?.currency ?? null,
        chargeVarianceMinor: variance,
        reason,
      }
      await appendGroupEvent(client, {
        organizationId,
        orderId: prepared.context.order_id,
        orderGlobalId,
        actorEmail,
        eventType: 'label.created',
        idempotencyKey: `${idempotencyKey}:group-event`,
        payload: eventPayload,
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.one_off_shipment.carrier_group.created',
        aggregateType: 'operations.order',
        aggregateId: orderGlobalId,
        subject: orderGlobalId,
        organizationId,
        eventKey: `operations:one-off-carrier-group:${organizationId}:${idempotencyKey}`,
        payload: eventPayload,
      }, client)
      const labels = await readResultLabels(
        organizationId,
        attempt.rows[0].id,
        client,
      )
      return {
        attempt: updatedAttempt.rows[0],
        rowVersion: numberValue(order.rows[0].row_version),
        labels,
      }
    })
  } catch {
    try {
      await query(
        `UPDATE operations_one_off_carrier_group_attempts
         SET state = 'unknown', redacted_response = $3::jsonb,
             provider_reference = $4,
             error_code = 'OPERATIONS_ONE_OFF_GROUP_FINALIZATION_UNKNOWN',
             completed_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND state = 'prepared'`,
        [
          organizationId,
          prepared.attempt.id,
          JSON.stringify(providerResult.evidence.redactedResponse),
          providerResult.evidence.providerReference,
        ],
      )
    } catch {
      // A still-prepared durable attempt also fences any duplicate Ship call.
    }
    fail(
      'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
      'The carrier created the shipment, but ClawPilot could not atomically retain every label; reconcile before retrying',
      503,
    )
  }
  const printed = await enqueueGroupPrints({
    organizationId,
    actorEmail,
    idempotencyKey,
    warehouseId: prepared.context.warehouse_id,
    preferredPrinterGlobalId,
    labels: finalized.labels,
  })
  return {
    orderGlobalId,
    orderStatus: 'packed',
    rowVersion: finalized.rowVersion,
    groupAttemptGlobalId: finalized.attempt.global_id,
    action: 'create',
    state: 'succeeded',
    executionMode: prepared.context.execution_mode,
    environment: finalized.attempt.environment,
    provider: finalized.attempt.provider,
    serviceCode: finalized.attempt.service_code,
    packageCount: finalized.attempt.package_count,
    masterTrackingNumber: finalized.attempt.master_tracking_number!,
    providerShipmentId: finalized.attempt.provider_shipment_id!,
    selectedAmountMinor: numberValue(finalized.attempt.selected_amount_minor),
    currency: finalized.attempt.currency,
    providerChargeMinor: finalized.attempt.provider_charge_minor === null
      ? null : numberValue(finalized.attempt.provider_charge_minor),
    providerChargeCurrency: finalized.attempt.provider_charge_currency,
    chargeVarianceMinor: finalized.attempt.charge_variance_minor === null
      ? null : numberValue(finalized.attempt.charge_variance_minor),
    labels: printed,
    replayed: false,
  }
}

type VoidCreateRow = GroupAttemptRow & {
  order_id: string
  plan_id: string
  planning_quote_id: string
  planning_offer_id: string
  purchase_quote_id: string
  purchase_offer_id: string
  carrier_rate_id: string
  integration_account_id: string
  integration_account_global_id: string
  carrier_account_id: string
  carrier_account_global_id: string
}

type VoidReplayRow = GroupAttemptRow & {
  order_id: string
  create_attempt_id: string
  reason: string
  create_provider_charge_minor: string | null
  create_provider_charge_currency: string | null
  create_charge_variance_minor: string | null
}

async function readVoidReplay(
  organizationId: string,
  idempotencyKey: string,
  client: PoolClient | null = null,
  lock = false,
) {
  const result = await dbQuery<VoidReplayRow>(
    client,
    `SELECT attempt.id::text, attempt.global_id, attempt.action,
            attempt.state, attempt.request_hash, attempt.redacted_request,
            attempt.redacted_response, attempt.provider_reference,
            attempt.master_tracking_number, attempt.provider_shipment_id,
            attempt.selected_amount_minor::text, attempt.currency,
            attempt.provider_charge_minor::text,
            attempt.provider_charge_currency,
            attempt.charge_variance_minor::text, attempt.package_count,
            attempt.environment, attempt.provider, attempt.service_code,
            attempt.error_code, attempt.order_id::text,
            attempt.create_attempt_id::text, attempt.reason,
            create_attempt.provider_charge_minor::text
              AS create_provider_charge_minor,
            create_attempt.provider_charge_currency
              AS create_provider_charge_currency,
            create_attempt.charge_variance_minor::text
              AS create_charge_variance_minor
     FROM operations_one_off_carrier_group_attempts attempt
     JOIN operations_one_off_carrier_group_attempts create_attempt
       ON create_attempt.organization_id = attempt.organization_id
      AND create_attempt.id = attempt.create_attempt_id
      AND create_attempt.action = 'create'
     WHERE attempt.organization_id = $1::uuid
       AND attempt.action IN ('void', 'close_sample')
       AND attempt.idempotency_key = $2
     LIMIT 1
     ${lock ? 'FOR UPDATE OF attempt' : ''}`,
    [organizationId, idempotencyKey],
  )
  return result.rows[0] || null
}

function assertVoidReplayRequest(input: {
  attempt: VoidReplayRow
  orderId: string
  reason: string
}) {
  if (input.attempt.order_id !== input.orderId || input.attempt.reason !== input.reason) {
    fail(
      'OPERATIONS_IDEMPOTENCY_CONFLICT',
      'This Idempotency-Key is already bound to another whole-shipment cancellation',
    )
  }
  if (input.attempt.state !== 'succeeded') {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
      `Carrier group cancellation ${input.attempt.global_id} is ${input.attempt.state}; reconcile it before another call`,
    )
  }
}

async function replayVoidedGroup(input: {
  organizationId: string
  orderGlobalId: string
  context: GroupContext
  attempt: VoidReplayRow
}): Promise<OneOffCarrierGroupCommandResult> {
  const labels = await readResultLabels(
    input.organizationId,
    input.attempt.create_attempt_id,
  )
  if (
    labels.length !== input.attempt.package_count
    || labels.some((label) => label.status !== 'voided')
  ) {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
      'The completed cancellation is missing its exact voided package-label set',
    )
  }
  return {
    orderGlobalId: input.orderGlobalId,
    orderStatus: 'packed',
    rowVersion: numberValue(input.context.row_version),
    groupAttemptGlobalId: input.attempt.global_id,
    action: input.attempt.action,
    state: 'succeeded',
    executionMode: input.context.execution_mode,
    environment: input.attempt.environment,
    provider: input.attempt.provider,
    serviceCode: input.attempt.service_code,
    packageCount: input.attempt.package_count,
    masterTrackingNumber: input.attempt.master_tracking_number!,
    providerShipmentId: input.attempt.provider_shipment_id!,
    selectedAmountMinor: numberValue(input.attempt.selected_amount_minor),
    currency: input.attempt.currency,
    providerChargeMinor: input.attempt.create_provider_charge_minor === null
      ? null : numberValue(input.attempt.create_provider_charge_minor),
    providerChargeCurrency: input.attempt.create_provider_charge_currency,
    chargeVarianceMinor: input.attempt.create_charge_variance_minor === null
      ? null : numberValue(input.attempt.create_charge_variance_minor),
    labels: labels.map((label) => ({
      packageGlobalId: label.package_global_id,
      packageNumber: label.package_number,
      labelGlobalId: label.label_global_id,
      trackingNumber: label.tracking_number,
      status: 'voided',
      printJobGlobalId: null,
      printWarning: null,
    })),
    replayed: true,
  }
}

async function readVoidCreateAttempt(
  organizationId: string,
  context: GroupContext,
  client: PoolClient | null,
  lock: boolean,
) {
  const result = await dbQuery<VoidCreateRow>(
    client,
    `SELECT attempt.id::text, attempt.global_id, attempt.action,
            attempt.state, attempt.request_hash, attempt.redacted_request,
            attempt.redacted_response, attempt.provider_reference,
            attempt.master_tracking_number, attempt.provider_shipment_id,
            attempt.selected_amount_minor::text, attempt.currency,
            attempt.provider_charge_minor::text,
            attempt.provider_charge_currency,
            attempt.charge_variance_minor::text,
            attempt.package_count, attempt.environment, attempt.provider,
            attempt.service_code, attempt.error_code,
            attempt.order_id::text, attempt.plan_id::text,
            attempt.planning_quote_id::text,
            attempt.planning_offer_id::text,
            attempt.purchase_quote_id::text,
            attempt.purchase_offer_id::text,
            attempt.carrier_rate_id::text,
            attempt.integration_account_id::text,
            integration.global_id AS integration_account_global_id,
            attempt.carrier_account_id::text,
            carrier_account.global_id AS carrier_account_global_id
     FROM operations_one_off_carrier_group_attempts attempt
     JOIN operations_integration_accounts integration
       ON integration.organization_id = attempt.organization_id
      AND integration.id = attempt.integration_account_id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = attempt.organization_id
      AND carrier_account.integration_account_id = attempt.integration_account_id
      AND carrier_account.id = attempt.carrier_account_id
     WHERE attempt.organization_id = $1::uuid
       AND attempt.order_id = $2::uuid AND attempt.plan_id = $3::uuid
       AND attempt.action = 'create' AND attempt.state = 'succeeded'
       AND NOT EXISTS (
         SELECT 1
         FROM operations_one_off_carrier_group_attempts closed
         WHERE closed.organization_id = attempt.organization_id
           AND closed.create_attempt_id = attempt.id
           AND closed.action IN ('void', 'close_sample')
           AND closed.state = 'succeeded'
       )
     ORDER BY attempt.completed_at DESC, attempt.id DESC
     LIMIT 1
     ${lock ? 'FOR UPDATE OF attempt' : ''}`,
    [organizationId, context.order_id, context.plan_id],
  )
  if (!result.rows[0]) {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_VOID_UNAVAILABLE',
      'This order does not have one complete active one-off carrier shipment to cancel',
    )
  }
  return result.rows[0]
}

export async function voidOperationsOneOffCarrierGroupInPostgres(input: {
  organizationId: string
  actorEmail: string
  canPurchaseLivePostage: boolean
  idempotencyKey: string
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
}): Promise<OneOffCarrierGroupCommandResult> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const actorEmail = requiredText(input.actorEmail, 'Actor', 320).toLowerCase()
  const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey)
  const orderGlobalId = requiredId(input.orderGlobalId, 'Order', ORDER_GLOBAL_ID)
  const expectedRowVersion = requiredVersion(input.expectedRowVersion)
  const reason = requiredText(input.reason, 'Whole-shipment void reason', 500)
  const initial = await readGroupContext(organizationId, orderGlobalId, null, false)
  if (initial.execution_mode === 'live' && !input.canPurchaseLivePostage) {
    fail(
      'SHIPPING_LIVE_POSTAGE_PERMISSION_REQUIRED',
      'Live carrier cancellation requires live-postage permission',
      403,
    )
  }
  const replay = await readVoidReplay(organizationId, idempotencyKey)
  if (replay) {
    assertVoidReplayRequest({
      attempt: replay,
      orderId: initial.order_id,
      reason,
    })
    return replayVoidedGroup({
      organizationId,
      orderGlobalId,
      context: initial,
      attempt: replay,
    })
  }
  if (
    initial.order_status !== 'packed'
    || numberValue(initial.row_version) !== expectedRowVersion
  ) {
    fail(
      'OPERATIONS_ORDER_VERSION_CONFLICT',
      'The packed order changed. Refresh it before cancelling the carrier shipment.',
    )
  }
  const createAttempt = await readVoidCreateAttempt(
    organizationId,
    initial,
    null,
    false,
  )
  const activeLabels = await readResultLabels(
    organizationId,
    createAttempt.id,
  )
  if (
    activeLabels.length !== createAttempt.package_count
    || activeLabels.some((label) => label.status !== 'created')
    || !createAttempt.master_tracking_number
    || !createAttempt.provider_shipment_id
  ) {
    fail(
      'OPERATIONS_ONE_OFF_GROUP_VOID_UNAVAILABLE',
      'Whole-shipment cancellation requires the complete active package-label set',
    )
  }
  const lifecycleMode = carrierOneOffGroupLifecycleMode({
    provider: createAttempt.provider,
    environment: createAttempt.environment,
    masterTrackingNumber: createAttempt.master_tracking_number,
    providerShipmentId: createAttempt.provider_shipment_id,
    packageTrackingNumbers: activeLabels.map((label) => label.tracking_number),
  })
  const attemptCorrelationKey = `oneoff_void_${oneOffShipmentHash({
    organizationId,
    orderGlobalId,
    idempotencyKey,
  }).slice(0, 49)}`
  const runtimeSource = lifecycleMode === 'close_sample'
    ? null
    : await resolveCarrierOneOffVoidRuntime({
        organizationId,
        provider: createAttempt.provider,
        environment: createAttempt.environment,
        integrationAccountGlobalId: createAttempt.integration_account_global_id,
        carrierAccountGlobalId: createAttempt.carrier_account_global_id,
      })
  const runtime = runtimeSource ? groupRuntime(runtimeSource) : null
  const preparedVoid = runtime
    ? prepareCarrierOneOffGroupVoidRequest({
        runtime,
        masterTrackingNumber: createAttempt.master_tracking_number,
        providerShipmentId: createAttempt.provider_shipment_id,
        packageTrackingNumbers: activeLabels.map((label) => label.tracking_number),
        attemptCorrelationKey,
      })
    : null
  const localRequest = preparedVoid?.redactedRequest || {
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    purpose: 'one_off_multi_package_sample_close',
    provider: createAttempt.provider,
    environment: createAttempt.environment,
    providerShipmentId: createAttempt.provider_shipment_id,
    masterTrackingNumber: createAttempt.master_tracking_number,
    packageTrackingNumbers: activeLabels.map((label) => label.tracking_number),
    carrierCallMade: false,
    lifecycleMode: 'close_sample',
  }
  const requestHash = preparedVoid?.requestHash || oneOffShipmentHash(localRequest)

  const prepared = await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:one-off-carrier-group:${organizationId}:${orderGlobalId}`,
    )
    const context = await readGroupContext(
      organizationId,
      orderGlobalId,
      client,
      true,
    )
    if (context.execution_mode === 'live' && !input.canPurchaseLivePostage) {
      fail(
        'SHIPPING_LIVE_POSTAGE_PERMISSION_REQUIRED',
        'Live carrier cancellation requires live-postage permission',
        403,
      )
    }
    const racedReplay = await readVoidReplay(
      organizationId,
      idempotencyKey,
      client,
      true,
    )
    if (racedReplay) {
      assertVoidReplayRequest({
        attempt: racedReplay,
        orderId: context.order_id,
        reason,
      })
      return { context, attempt: racedReplay, replayed: true as const }
    }
    if (
      context.order_status !== 'packed'
      || numberValue(context.row_version) !== expectedRowVersion
    ) {
      fail(
        'OPERATIONS_ORDER_VERSION_CONFLICT',
        'The order changed before the whole-shipment void was prepared',
      )
    }
    const lockedCreate = await readVoidCreateAttempt(
      organizationId,
      context,
      client,
      true,
    )
    if (lockedCreate.id !== createAttempt.id) {
      fail(
        'OPERATIONS_ONE_OFF_GROUP_VOID_CONFLICT',
        'The active whole-shipment carrier group changed before cancellation',
      )
    }
    const inserted = await client.query<GroupAttemptRow>(
      `INSERT INTO operations_one_off_carrier_group_attempts (
         organization_id, order_id, plan_id,
         planning_quote_id, planning_offer_id,
         purchase_quote_id, purchase_offer_id, carrier_rate_id,
         integration_account_id, carrier_account_id, create_attempt_id,
         action, environment, provider, service_code, package_count,
         selected_amount_minor, currency, adapter_version,
         idempotency_key, request_hash, redacted_request,
         master_tracking_number, provider_shipment_id,
         reason, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid,
         $12, $13, $14, $15, $16, $17, $18, $19,
         $20, $21, $22::jsonb, $23, $24, $25, $26
       )
       RETURNING id::text, global_id, action, state, request_hash,
                 redacted_request, redacted_response, provider_reference,
                 master_tracking_number, provider_shipment_id,
                 selected_amount_minor::text, currency,
                 provider_charge_minor::text, provider_charge_currency,
                 charge_variance_minor::text, package_count, environment,
                 provider, service_code, error_code`,
      [
        organizationId,
        context.order_id,
        context.plan_id,
        lockedCreate.planning_quote_id,
        lockedCreate.planning_offer_id,
        lockedCreate.purchase_quote_id,
        lockedCreate.purchase_offer_id,
        lockedCreate.carrier_rate_id,
        lockedCreate.integration_account_id,
        lockedCreate.carrier_account_id,
        lockedCreate.id,
        lifecycleMode === 'close_sample' ? 'close_sample' : 'void',
        lockedCreate.environment,
        lockedCreate.provider,
        lockedCreate.service_code,
        lockedCreate.package_count,
        lockedCreate.selected_amount_minor,
        lockedCreate.currency,
        CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
        idempotencyKey,
        requestHash,
        JSON.stringify(localRequest),
        lockedCreate.master_tracking_number,
        lockedCreate.provider_shipment_id,
        reason,
        actorEmail,
      ],
    )
    return { context, attempt: inserted.rows[0], replayed: false as const }
  })

  if (prepared.replayed) {
    return replayVoidedGroup({
      organizationId,
      orderGlobalId,
      context: prepared.context,
      attempt: prepared.attempt,
    })
  }

  const voidExecutable = await query<{ valid: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_one_off_carrier_group_attempts close_attempt
       JOIN operations_one_off_carrier_group_attempts create_attempt
         ON create_attempt.organization_id = close_attempt.organization_id
        AND create_attempt.id = close_attempt.create_attempt_id
       JOIN operations_orders source_order
         ON source_order.organization_id = close_attempt.organization_id
        AND source_order.id = close_attempt.order_id
       WHERE close_attempt.organization_id = $1::uuid
         AND close_attempt.id = $2::uuid
         AND close_attempt.state = 'prepared'
         AND close_attempt.action IN ('void', 'close_sample')
         AND create_attempt.action = 'create'
         AND create_attempt.state = 'succeeded'
         AND source_order.status = 'packed'
         AND NOT EXISTS (
           SELECT 1 FROM operations_shipments shipment
           WHERE shipment.organization_id = close_attempt.organization_id
             AND shipment.order_id = close_attempt.order_id
         )
         AND (
           SELECT count(*)
           FROM operations_one_off_carrier_group_members member
           JOIN operations_packages package
             ON package.organization_id = member.organization_id
            AND package.id = member.package_id
           JOIN operations_labels label
             ON label.organization_id = member.organization_id
            AND label.package_id = member.package_id
            AND label.one_off_carrier_group_attempt_id = member.carrier_group_attempt_id
           WHERE member.organization_id = create_attempt.organization_id
             AND member.carrier_group_attempt_id = create_attempt.id
             AND package.status = 'labeled'
             AND label.status = 'created'
             AND label.one_off_void_group_attempt_id IS NULL
         ) = create_attempt.package_count
     ) AS valid`,
    [organizationId, prepared.attempt.id],
  )
  if (!voidExecutable.rows[0]?.valid) {
    const fenced = new CarrierOneOffGroupError(
      'The order, package labels, or shipment state changed before cancellation; no carrier call was made',
      409,
      'OPERATIONS_ONE_OFF_GROUP_VOID_PRECALL_FENCE_FAILED',
      false,
      { carrierCallMade: false },
    )
    await finalizeAttemptFailure({
      organizationId,
      attemptId: prepared.attempt.id,
      error: fenced,
    })
    throw new OneOffShipmentPersistenceError(
      fenced.code,
      fenced.message,
      fenced.status,
    )
  }

  let voidEvidence: CarrierOneOffGroupShipmentResult['evidence']
  if (preparedVoid && runtime) {
    try {
      const freshRuntimeSource = await resolveCarrierOneOffVoidRuntime({
        organizationId,
        provider: createAttempt.provider,
        environment: createAttempt.environment,
        integrationAccountGlobalId: createAttempt.integration_account_global_id,
        carrierAccountGlobalId: createAttempt.carrier_account_global_id,
      })
      const providerResult = await executeCarrierOneOffGroupVoid({
        runtime: groupRuntime(freshRuntimeSource),
        prepared: preparedVoid,
      })
      voidEvidence = providerResult.evidence
    } catch (error) {
      const carrierError = terminalCarrierError(error)
      await finalizeAttemptFailure({
        organizationId,
        attemptId: prepared.attempt.id,
        error: carrierError,
      })
      throw new OneOffShipmentPersistenceError(
        carrierError.code,
        carrierError.message,
        carrierError.status,
      )
    }
  } else {
    const now = new Date().toISOString()
    voidEvidence = {
      requestHash,
      redactedRequest: localRequest,
      redactedResponse: {
        carrierCallMade: false,
        carrierWrites: 0,
        result: 'confirmed_no_active_label',
        lifecycleMode: 'close_sample',
        providerShipmentId: createAttempt.provider_shipment_id,
        masterTrackingNumber: createAttempt.master_tracking_number,
      },
      providerReference: createAttempt.provider_shipment_id!,
      requestedAt: now,
      completedAt: now,
    }
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:one-off-carrier-group:${organizationId}:${orderGlobalId}`,
      )
      const attempt = await client.query<GroupAttemptRow>(
        `SELECT id::text, global_id, action, state, request_hash,
                redacted_request, redacted_response, provider_reference,
                master_tracking_number, provider_shipment_id,
                selected_amount_minor::text, currency,
                provider_charge_minor::text, provider_charge_currency,
                charge_variance_minor::text, package_count, environment,
                provider, service_code, error_code
         FROM operations_one_off_carrier_group_attempts
         WHERE organization_id = $1::uuid AND id = $2::uuid
         LIMIT 1 FOR UPDATE`,
        [organizationId, prepared.attempt.id],
      )
      if (
        !attempt.rows[0]
        || attempt.rows[0].state !== 'prepared'
        || attempt.rows[0].request_hash !== voidEvidence.requestHash
      ) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'The durable whole-shipment cancellation changed before finalization',
        )
      }
      const updatedLabels = await client.query<ResultLabelRow>(
        `UPDATE operations_labels label
         SET status = 'voided', one_off_void_group_attempt_id = $3::uuid,
             voided_at = now(), voided_by = $4,
             redacted_provider_evidence = label.redacted_provider_evidence
               || $5::jsonb
         FROM operations_one_off_carrier_group_members member,
              operations_packages package
         WHERE member.organization_id = $1::uuid
           AND member.carrier_group_attempt_id = $2::uuid
           AND package.organization_id = member.organization_id
           AND package.id = member.package_id
           AND label.organization_id = member.organization_id
           AND label.package_id = member.package_id
           AND label.one_off_carrier_group_attempt_id = member.carrier_group_attempt_id
           AND label.status = 'created'
         RETURNING package.global_id AS package_global_id,
                   member.package_number, label.global_id AS label_global_id,
                   label.tracking_number, label.status`,
        [
          organizationId,
          createAttempt.id,
          attempt.rows[0].id,
          actorEmail,
          JSON.stringify({ void: voidEvidence }),
        ],
      )
      if (updatedLabels.rows.length !== attempt.rows[0].package_count) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'Whole-shipment cancellation did not cover every active package label',
        )
      }
      const packedPackages = await client.query<{ id: string }>(
        `UPDATE operations_packages package
         SET status = 'packed'
         FROM operations_one_off_carrier_group_members member
         WHERE member.organization_id = $1::uuid
           AND member.carrier_group_attempt_id = $2::uuid
           AND package.organization_id = member.organization_id
           AND package.id = member.package_id
           AND package.status = 'labeled'
         RETURNING package.id::text`,
        [organizationId, createAttempt.id],
      )
      if (packedPackages.rows.length !== attempt.rows[0].package_count) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'Whole-shipment cancellation did not return every labeled package to packed',
        )
      }
      const completed = await client.query<GroupAttemptRow>(
        `UPDATE operations_one_off_carrier_group_attempts
         SET state = 'succeeded', redacted_response = $3::jsonb,
             provider_reference = $4, completed_at = $5::timestamptz
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND state = 'prepared'
         RETURNING id::text, global_id, action, state, request_hash,
                   redacted_request, redacted_response, provider_reference,
                   master_tracking_number, provider_shipment_id,
                   selected_amount_minor::text, currency,
                   provider_charge_minor::text, provider_charge_currency,
                   charge_variance_minor::text, package_count, environment,
                   provider, service_code, error_code`,
        [
          organizationId,
          attempt.rows[0].id,
          JSON.stringify(voidEvidence.redactedResponse),
          voidEvidence.providerReference,
          voidEvidence.completedAt,
        ],
      )
      const order = await client.query<{ row_version: string }>(
        `UPDATE operations_orders
         SET row_version = row_version + 1, updated_by = $3, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND status = 'packed'
         RETURNING row_version::text`,
        [organizationId, prepared.context.order_id, actorEmail],
      )
      if (!completed.rows[0] || !order.rows[0]) {
        fail(
          'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
          'Whole-shipment cancellation could not finalize exactly once',
        )
      }
      const eventPayload = {
        groupAttemptGlobalId: completed.rows[0].global_id,
        createGroupAttemptGlobalId: createAttempt.global_id,
        packageCount: updatedLabels.rows.length,
        masterTrackingNumber: createAttempt.master_tracking_number,
        providerShipmentId: createAttempt.provider_shipment_id,
        environment: createAttempt.environment,
        provider: createAttempt.provider,
        lifecycleMode,
        carrierCallMade: lifecycleMode !== 'close_sample',
        reason,
      }
      await appendGroupEvent(client, {
        organizationId,
        orderId: prepared.context.order_id,
        orderGlobalId,
        actorEmail,
        eventType: 'label.voided',
        idempotencyKey: `${idempotencyKey}:group-event`,
        payload: eventPayload,
      })
      await recordAuditEvent({
        actor: actorEmail,
        eventType: 'operations.one_off_shipment.carrier_group.voided',
        aggregateType: 'operations.order',
        aggregateId: orderGlobalId,
        subject: orderGlobalId,
        organizationId,
        eventKey: `operations:one-off-carrier-group:void:${organizationId}:${idempotencyKey}`,
        payload: eventPayload,
      }, client)
      return {
        orderGlobalId,
        orderStatus: 'packed' as const,
        rowVersion: numberValue(order.rows[0].row_version),
        groupAttemptGlobalId: completed.rows[0].global_id,
        action: completed.rows[0].action,
        state: 'succeeded' as const,
        executionMode: prepared.context.execution_mode,
        environment: completed.rows[0].environment,
        provider: completed.rows[0].provider,
        serviceCode: completed.rows[0].service_code,
        packageCount: completed.rows[0].package_count,
        masterTrackingNumber: completed.rows[0].master_tracking_number!,
        providerShipmentId: completed.rows[0].provider_shipment_id!,
        selectedAmountMinor: numberValue(completed.rows[0].selected_amount_minor),
        currency: completed.rows[0].currency,
        providerChargeMinor: createAttempt.provider_charge_minor === null
          ? null : numberValue(createAttempt.provider_charge_minor),
        providerChargeCurrency: createAttempt.provider_charge_currency,
        chargeVarianceMinor: createAttempt.charge_variance_minor === null
          ? null : numberValue(createAttempt.charge_variance_minor),
        labels: updatedLabels.rows.map((label) => ({
          packageGlobalId: label.package_global_id,
          packageNumber: label.package_number,
          labelGlobalId: label.label_global_id,
          trackingNumber: label.tracking_number,
          status: 'voided' as const,
          printJobGlobalId: null,
          printWarning: null,
        })),
        replayed: false,
      }
    })
  } catch {
    try {
      await query(
        `UPDATE operations_one_off_carrier_group_attempts
         SET state = 'unknown', redacted_response = $3::jsonb,
             provider_reference = $4,
             error_code = 'OPERATIONS_ONE_OFF_GROUP_VOID_FINALIZATION_UNKNOWN',
             completed_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND state = 'prepared'`,
        [
          organizationId,
          prepared.attempt.id,
          JSON.stringify(voidEvidence.redactedResponse),
          voidEvidence.providerReference,
        ],
      )
    } catch {
      // A still-prepared void attempt continues to block another carrier call.
    }
    fail(
      'OPERATIONS_ONE_OFF_GROUP_RECONCILIATION_REQUIRED',
      'The carrier cancellation completed, but ClawPilot could not atomically close every label; reconcile before retrying',
      503,
    )
  }
}
