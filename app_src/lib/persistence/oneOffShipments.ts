import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  CarrierIntegrationRequestError,
  getCarrierIntegrationsState,
  testCarrierSandboxShipmentRate,
} from '@/lib/integrations/carrierIntegrations'
import {
  oneOffProviderLabel,
  oneOffRateEnvironment,
  oneOffShipmentHash,
  type OneOffCarrierProvider,
  type OneOffRateEnvironment,
  type OneOffShipmentCreateResult,
  type OneOffShipmentLineInput,
  type OneOffShipmentPackageInput,
  type OneOffShipmentQuote,
  type OneOffShipmentQuoteInput,
  type OneOffShipmentWorkspace,
} from '@/lib/operations/oneOffShipments'
import type { Address, Millimeters } from '@/lib/operations/types'
import { stageCrmRecordWithClient } from '@/lib/persistence/crm'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import { upsertProductPackagingProfileWithClient } from '@/lib/persistence/productPackaging'

const CUSTOMER_GLOBAL_ID = /^ga(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_GLOBAL_ID = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/
const LOCATION_GLOBAL_ID = /^gwl(?:[0-9]{7}|[0-9a-v]{12})$/
const INVENTORY_POOL_GLOBAL_ID = /^gip(?:[0-9]{7}|[0-9a-v]{12})$/
const QUOTE_GLOBAL_ID = /^goq(?:[0-9]{7}|[0-9a-v]{12})$/
const OFFER_GLOBAL_ID = /^goo(?:[0-9]{7}|[0-9a-v]{12})$/
const IDEMPOTENCY_KEY = /^[^\u0000-\u001f\u007f]{8,160}$/
const MONEY = /^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/
const QUOTE_TTL_MS = 20 * 60_000
const COMMAND_RETRY_MS = 5 * 60_000
const DAY_MS = 86_400_000

export class OneOffShipmentPersistenceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'OneOffShipmentPersistenceError'
    this.code = code
    this.status = status
  }
}

function requestError(code: string, message: string, status = 400): never {
  throw new OneOffShipmentPersistenceError(code, message, status)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', `${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const allowedSet = new Set(allowed)
  const unsupported = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unsupported) {
    requestError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      `${label} includes unsupported field ${unsupported}`,
    )
  }
}

function text(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1,
) {
  const normalized = String(value ?? '').trim()
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', `${label} is invalid`)
  }
  return normalized
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    requestError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      `${label} must be an integer from ${minimum} to ${maximum}`,
    )
  }
  return parsed
}

function globalId(value: unknown, label: string, pattern: RegExp) {
  const normalized = String(value ?? '').trim()
  if (!pattern.test(normalized)) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', `${label} is invalid`)
  }
  return normalized
}

function dimensions(value: unknown, label: string): Millimeters {
  const source = record(value, label)
  exactFields(source, ['length', 'width', 'height'], label)
  return {
    length: integer(source.length, `${label} length`, 1, 100_000),
    width: integer(source.width, `${label} width`, 1, 100_000),
    height: integer(source.height, `${label} height`, 1, 100_000),
  }
}

function address(value: unknown): Address {
  const source = record(value, 'Recipient address')
  exactFields(
    source,
    ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'],
    'Recipient address',
  )
  const country = text(source.country, 'Recipient country', 2).toUpperCase()
  if (country !== 'US') {
    requestError(
      'OPERATIONS_ONE_OFF_DESTINATION_UNSUPPORTED',
      'The development one-off shipment slice supports US destinations only',
      409,
    )
  }
  const line2 = String(source.line2 ?? '').trim()
  if (line2.length > 120 || /[\u0000-\u001f\u007f]/.test(line2)) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'Recipient address line 2 is invalid')
  }
  const region = text(source.region, 'Recipient region', 2).toUpperCase()
  const postalCode = text(source.postalCode, 'Recipient postal code', 10)
  if (!/^[A-Z]{2}$/.test(region)) {
    requestError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      'Recipient region must be a two-letter US state or territory code',
    )
  }
  if (!/^\d{5}(?:-\d{4})?$/.test(postalCode)) {
    requestError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      'Recipient postal code must be a five-digit or ZIP+4 code',
    )
  }
  return {
    name: text(source.name, 'Recipient name', 120),
    line1: text(source.line1, 'Recipient address line 1', 120),
    line2: line2 || null,
    city: text(source.city, 'Recipient city', 100),
    region,
    postalCode,
    country,
  }
}

function line(value: unknown, index: number): OneOffShipmentLineInput {
  const source = record(value, `Line ${index + 1}`)
  const kind = text(source.kind, `Line ${index + 1} kind`, 20)
  if (kind === 'existing') {
    exactFields(source, ['kind', 'lineKey', 'productGlobalId', 'quantity'], `Line ${index + 1}`)
    return {
      kind,
      lineKey: text(source.lineKey, `Line ${index + 1} key`, 80),
      productGlobalId: globalId(
        source.productGlobalId,
        `Product on line ${index + 1}`,
        PRODUCT_GLOBAL_ID,
      ),
      quantity: integer(source.quantity, `Line ${index + 1} quantity`, 1, 1_000_000),
    }
  }
  if (kind !== 'new') {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', `Line ${index + 1} kind is invalid`)
  }
  exactFields(
    source,
    [
      'kind', 'lineKey', 'name', 'sku', 'quantity', 'unitPriceMinor',
      'unitWeightGrams', 'unitDimensionsMm', 'physicalUnitsOnHandConfirmed',
    ],
    `Line ${index + 1}`,
  )
  if (source.physicalUnitsOnHandConfirmed !== true) {
    requestError(
      'OPERATIONS_ONE_OFF_PHYSICAL_UNITS_REQUIRED',
      `Confirm the physical on-hand units for new product line ${index + 1}`,
      409,
    )
  }
  return {
    kind,
    lineKey: text(source.lineKey, `Line ${index + 1} key`, 80),
    name: text(source.name, `Line ${index + 1} product name`, 255),
    sku: text(source.sku, `Line ${index + 1} SKU`, 25),
    quantity: integer(source.quantity, `Line ${index + 1} quantity`, 1, 1_000_000),
    unitPriceMinor: integer(
      source.unitPriceMinor,
      `Line ${index + 1} unit value`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    unitWeightGrams: integer(
      source.unitWeightGrams,
      `Line ${index + 1} unit weight`,
      1,
      100_000_000,
    ),
    unitDimensionsMm: dimensions(
      source.unitDimensionsMm,
      `Line ${index + 1} unit dimensions`,
    ),
    physicalUnitsOnHandConfirmed: true,
  }
}

function parcel(value: unknown, index: number): OneOffShipmentPackageInput {
  const source = record(value, `Parcel ${index + 1}`)
  exactFields(
    source,
    ['packageKey', 'description', 'dimensionsMm', 'grossWeightGrams', 'allocations'],
    `Parcel ${index + 1}`,
  )
  if (!Array.isArray(source.allocations) || source.allocations.length < 1 || source.allocations.length > 25) {
    requestError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      `Parcel ${index + 1} must contain 1-25 line allocations`,
    )
  }
  const allocations = source.allocations.map((entry, allocationIndex) => {
    const allocation = record(entry, `Parcel ${index + 1} allocation ${allocationIndex + 1}`)
    exactFields(
      allocation,
      ['lineKey', 'quantity'],
      `Parcel ${index + 1} allocation ${allocationIndex + 1}`,
    )
    return {
      lineKey: text(
        allocation.lineKey,
        `Parcel ${index + 1} allocation ${allocationIndex + 1} line key`,
        80,
      ),
      quantity: integer(
        allocation.quantity,
        `Parcel ${index + 1} allocation ${allocationIndex + 1} quantity`,
        1,
        1_000_000,
      ),
    }
  })
  if (new Set(allocations.map((entry) => entry.lineKey)).size !== allocations.length) {
    requestError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      `Parcel ${index + 1} contains a duplicate line allocation`,
    )
  }
  return {
    packageKey: text(source.packageKey, `Parcel ${index + 1} key`, 80),
    description: text(source.description, `Parcel ${index + 1} description`, 255),
    dimensionsMm: dimensions(source.dimensionsMm, `Parcel ${index + 1} dimensions`),
    grossWeightGrams: integer(
      source.grossWeightGrams,
      `Parcel ${index + 1} gross weight`,
      1,
      100_000_000,
    ),
    allocations,
  }
}

export function validateOneOffShipmentQuoteInput(value: unknown): OneOffShipmentQuoteInput {
  const source = record(value, 'One-off shipment quote')
  exactFields(
    source,
    [
      'customerGlobalId', 'warehouseGlobalId', 'inventoryPoolGlobalId',
      'receivingLocationGlobalId', 'referenceNumber', 'currency',
      'requestedDeliveryAt', 'shipTo', 'lines', 'packages',
    ],
    'One-off shipment quote',
  )
  if (!Array.isArray(source.lines) || source.lines.length < 1 || source.lines.length > 25) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'A one-off shipment requires 1-25 lines')
  }
  if (!Array.isArray(source.packages) || source.packages.length < 1 || source.packages.length > 50) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'A one-off shipment requires 1-50 parcels')
  }
  const lines = source.lines.map(line)
  const packages = source.packages.map(parcel)
  const lineKeys = new Set(lines.map((entry) => entry.lineKey))
  if (lineKeys.size !== lines.length) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'Shipment line keys must be unique')
  }
  if (new Set(packages.map((entry) => entry.packageKey)).size !== packages.length) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'Parcel keys must be unique')
  }
  const newSkus = lines
    .filter((entry): entry is Extract<OneOffShipmentLineInput, { kind: 'new' }> => entry.kind === 'new')
    .map((entry) => entry.sku.toLowerCase())
  if (new Set(newSkus).size !== newSkus.length) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'New product SKUs must be unique')
  }
  const newProductNames = lines
    .filter((entry): entry is Extract<OneOffShipmentLineInput, { kind: 'new' }> => entry.kind === 'new')
    .map((entry) => entry.name.toLowerCase())
  if (new Set(newProductNames).size !== newProductNames.length) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'New product names must be unique')
  }
  const existingProductGlobalIds = lines.flatMap((entry) => (
    entry.kind === 'existing' ? [entry.productGlobalId] : []
  ))
  if (new Set(existingProductGlobalIds).size !== existingProductGlobalIds.length) {
    requestError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      'Each existing product may appear on only one shipment line',
    )
  }
  const allocated = new Map(lines.map((entry) => [entry.lineKey, 0]))
  for (const item of packages) {
    for (const allocation of item.allocations) {
      if (!lineKeys.has(allocation.lineKey)) {
        requestError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          `Parcel ${item.packageKey} references an unknown shipment line`,
        )
      }
      allocated.set(
        allocation.lineKey,
        (allocated.get(allocation.lineKey) || 0) + allocation.quantity,
      )
    }
  }
  for (const item of lines) {
    if (allocated.get(item.lineKey) !== item.quantity) {
      requestError(
        'OPERATIONS_ONE_OFF_PACKAGE_ALLOCATION_INVALID',
        `Parcel allocations must total exactly ${item.quantity} for line ${item.lineKey}`,
        409,
      )
    }
  }
  const currency = text(source.currency, 'Currency', 3).toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'Currency must be a three-letter code')
  }
  let requestedDeliveryAt: string | null = null
  if (source.requestedDeliveryAt !== null && source.requestedDeliveryAt !== undefined && source.requestedDeliveryAt !== '') {
    const parsed = new Date(String(source.requestedDeliveryAt))
    if (Number.isNaN(parsed.getTime())) {
      requestError('OPERATIONS_ONE_OFF_REQUEST_INVALID', 'Requested delivery timestamp is invalid')
    }
    requestedDeliveryAt = parsed.toISOString()
  }
  return {
    customerGlobalId: globalId(source.customerGlobalId, 'Customer', CUSTOMER_GLOBAL_ID),
    warehouseGlobalId: globalId(source.warehouseGlobalId, 'Warehouse', WAREHOUSE_GLOBAL_ID),
    inventoryPoolGlobalId: globalId(
      source.inventoryPoolGlobalId,
      'Inventory pool',
      INVENTORY_POOL_GLOBAL_ID,
    ),
    receivingLocationGlobalId: globalId(
      source.receivingLocationGlobalId,
      'Receiving or pick location',
      LOCATION_GLOBAL_ID,
    ),
    referenceNumber: text(source.referenceNumber, 'Shipment reference', 120),
    currency,
    requestedDeliveryAt,
    shipTo: address(source.shipTo),
    lines,
    packages,
  }
}

function requireOrganizationId(value: string) {
  const organizationId = String(value || '').trim()
  if (!organizationId) {
    requestError('ACTIVE_ORGANIZATION_REQUIRED', 'Select an active organization first', 409)
  }
  return organizationId
}

function requireIdempotencyKey(value: string) {
  const key = String(value || '').trim()
  if (!IDEMPOTENCY_KEY.test(key)) {
    requestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return key
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function moneyMinor(value: string) {
  if (!MONEY.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const minor = BigInt(`${whole}${fraction.padEnd(2, '0')}`)
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null
}

function rateDelivery(
  testedAt: string,
  deliveryDate: string | null,
  transitDays: number | null,
) {
  if (deliveryDate) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)
      ? new Date(`${deliveryDate}T23:59:59.000Z`)
      : new Date(deliveryDate)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  if (Number.isSafeInteger(transitDays) && Number(transitDays) >= 0) {
    const tested = new Date(testedAt)
    if (!Number.isNaN(tested.getTime())) {
      return new Date(tested.getTime() + Number(transitDays) * DAY_MS).toISOString()
    }
  }
  return null
}

function carrierDestination(value: Address) {
  return {
    name: value.name,
    line1: value.line1,
    line2: value.line2 || null,
    city: value.city,
    region: value.region,
    postalCode: value.postalCode,
    countryCode: value.country,
  }
}

function carrierParcels(packages: OneOffShipmentPackageInput[]) {
  return packages.map((item) => ({
    description: item.description,
    length: Math.max(0.01, Number((item.dimensionsMm.length / 25.4).toFixed(3))),
    width: Math.max(0.01, Number((item.dimensionsMm.width / 25.4).toFixed(3))),
    height: Math.max(0.01, Number((item.dimensionsMm.height / 25.4).toFixed(3))),
    dimensionUnit: 'IN' as const,
    weight: Math.max(0.01, Number((item.grossWeightGrams / 453.59237).toFixed(3))),
    weightUnit: 'LB' as const,
  }))
}

type ActivationRow = QueryResultRow & {
  pipeline_id: string
  state: 'disabled' | 'shadow' | 'read_only' | 'active' | 'frozen'
}

async function activation(client: PoolClient, organizationId: string, lock = false) {
  const result = await client.query<ActivationRow>(
    `SELECT data_pipeline_id::text AS pipeline_id, state
     FROM operations_activation_scopes
     WHERE organization_id = $1::uuid
     ${lock ? 'FOR UPDATE' : ''}`,
    [organizationId],
  )
  if (!result.rows[0]) {
    requestError(
      'OPERATIONS_ACTIVATION_UNAVAILABLE',
      'Initialize Operations before creating a one-off shipment',
      409,
    )
  }
  return result.rows[0]
}

type EnabledCarrier = {
  provider: OneOffCarrierProvider
  integrationAccountGlobalId: string
  integrationAccountId: string
  carrierAccountGlobalId: string
  carrierAccountId: string
  credentialVersion: number
  displayName: string
  senderOriginWarehouseGlobalId: string | null
}

async function enabledCarriers(
  organizationId: string,
  warehouseGlobalId?: string,
): Promise<EnabledCarrier[]> {
  if (oneOffRateEnvironment() !== 'sandbox') return []
  const state = await getCarrierIntegrationsState(organizationId)
  const eligible = state.accounts.filter((account) => (
    (account.provider === 'ups_rest' || account.provider === 'fedex_rest')
    && account.environment === 'sandbox'
    && account.status === 'active'
    && account.configured
    && account.verificationStatus === 'verified'
    && account.credentialVersion > 0
    && account.allowedCapabilities.includes('sandbox_rate')
    && (
      !warehouseGlobalId
      || !account.senderOriginWarehouseGlobalId
      || account.senderOriginWarehouseGlobalId === warehouseGlobalId
    )
  ))
  const selected = eligible.map((account) => {
    const candidates = account.carrierAccounts.filter((carrierAccount) => (
      carrierAccount.status === 'active' && carrierAccount.allowSenderBilling
    ))
    if (candidates.length > 1) {
      requestError(
        'OPERATIONS_ONE_OFF_CARRIER_ACCOUNT_AMBIGUOUS',
        `${account.displayName} has multiple enabled sender accounts; retain one active sender account before one-off rating`,
        409,
      )
    }
    return candidates[0] ? { account, carrierAccount: candidates[0] } : null
  }).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  if (!selected.length) return []
  const identities = await query<{
    integration_global_id: string
    integration_id: string
    carrier_account_global_id: string
    carrier_account_id: string
  }>(
    `SELECT integration.global_id AS integration_global_id,
            integration.id::text AS integration_id,
            carrier.global_id AS carrier_account_global_id,
            carrier.id::text AS carrier_account_id
     FROM operations_integration_accounts integration
     JOIN operations_carrier_accounts carrier
       ON carrier.organization_id = integration.organization_id
      AND carrier.integration_account_id = integration.id
     WHERE integration.organization_id = $1::uuid
       AND integration.global_id = ANY($2::text[])
       AND carrier.global_id = ANY($3::text[])`,
    [
      organizationId,
      selected.map((entry) => entry.account.globalId),
      selected.map((entry) => entry.carrierAccount.globalId),
    ],
  )
  const byKey = new Map(identities.rows.map((row) => [
    `${row.integration_global_id}:${row.carrier_account_global_id}`,
    row,
  ]))
  return selected.map(({ account, carrierAccount }) => {
    const row = byKey.get(`${account.globalId}:${carrierAccount.globalId}`)
    if (!row) {
      requestError(
        'OPERATIONS_ONE_OFF_CARRIER_UNAVAILABLE',
        'An enabled carrier account could not be resolved',
        409,
      )
    }
    return {
      provider: account.provider as OneOffCarrierProvider,
      integrationAccountGlobalId: account.globalId,
      integrationAccountId: row.integration_id,
      carrierAccountGlobalId: carrierAccount.globalId,
      carrierAccountId: row.carrier_account_id,
      credentialVersion: account.credentialVersion,
      displayName: carrierAccount.displayName,
      senderOriginWarehouseGlobalId: account.senderOriginWarehouseGlobalId,
    }
  }).sort((left, right) => (
    (left.provider === 'ups_rest' ? 0 : 1)
    - (right.provider === 'ups_rest' ? 0 : 1)
  ))
}

function workspaceAddress(value: unknown): Address {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    name: String(source.name || source.companyName || '').trim(),
    line1: String(source.line1 || source.street || '').trim(),
    line2: String(source.line2 || '').trim() || null,
    city: String(source.city || '').trim(),
    region: String(source.region || source.state || '').trim(),
    postalCode: String(source.postalCode || '').trim(),
    country: String(source.country || source.countryCode || 'US').trim().toUpperCase(),
  }
}

export async function readOneOffShipmentWorkspaceFromPostgres(input: {
  organizationId: string
}): Promise<OneOffShipmentWorkspace> {
  const organizationId = requireOrganizationId(input.organizationId)
  const resolvedActivation = await withTransaction((client) => activation(client, organizationId))
  const [customers, warehouses, pools, locations, products, carriers] = await Promise.all([
    query<{ global_id: string; name: string }>(
      `SELECT reference_code AS global_id, name
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid
         AND COALESCE(lower(source_payload->>'archived'), 'false')
           NOT IN ('true', '1', 'yes')
       ORDER BY lower(name), id
       LIMIT 500`,
      [resolvedActivation.pipeline_id],
    ),
    query<{ global_id: string; name: string; address: unknown }>(
      `SELECT global_id, name, address
       FROM operations_warehouses
       WHERE organization_id = $1::uuid AND status = 'active'
         AND code <> 'MOCK-01'
       ORDER BY lower(name), id`,
      [organizationId],
    ),
    query<{ global_id: string; name: string }>(
      `SELECT global_id, name
       FROM operations_inventory_pools
       WHERE organization_id = $1::uuid
         AND pipeline_id = $2::uuid
         AND active = true
       ORDER BY lower(name), id`,
      [organizationId, resolvedActivation.pipeline_id],
    ),
    query<{
      global_id: string
      warehouse_id: string
      code: string
    }>(
      `SELECT location.global_id, location.warehouse_id::text, location.code
       FROM operations_locations location
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = location.organization_id
        AND warehouse.id = location.warehouse_id
       WHERE location.organization_id = $1::uuid
         AND location.active = true
         AND location.location_type IN ('receiving', 'pick')
         AND warehouse.status = 'active'
       ORDER BY location.warehouse_id, location.pick_sequence, location.code, location.id`,
      [organizationId],
    ),
    query<{
      id: string
      global_id: string
      name: string
      sku: string | null
      unit_price_minor: string
      profile_row_version: string | null
      units_per_package: number | null
      length_mm: number | null
      width_mm: number | null
      height_mm: number | null
      weight_grams: number | null
      availability: Array<{
        warehouseGlobalId: string
        inventoryPoolGlobalId: string
        availableQuantity: number | string
      }> | null
    }>(
      `SELECT product.id::text, product.reference_code AS global_id,
              product.name, NULLIF(btrim(product.sku), '') AS sku,
              round(COALESCE(product.price, 0) * 100)::bigint::text
                AS unit_price_minor,
              profile.row_version::text AS profile_row_version,
              profile.units_per_package, profile.length_mm, profile.width_mm,
              profile.height_mm, profile.weight_grams,
              COALESCE(availability.items, '[]'::jsonb) AS availability
       FROM crm_products product
       LEFT JOIN LATERAL (
         SELECT candidate.*
         FROM operations_product_package_profiles candidate
         WHERE candidate.organization_id = $1::uuid
           AND candidate.pipeline_id = product.pipeline_id
           AND candidate.product_id = product.id
           AND candidate.active = true
         ORDER BY candidate.is_default DESC, candidate.updated_at DESC, candidate.id
         LIMIT 1
       ) profile ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'warehouseGlobalId', grouped.warehouse_global_id,
           'inventoryPoolGlobalId', grouped.pool_global_id,
           'availableQuantity', grouped.available_quantity
         ) ORDER BY grouped.warehouse_global_id, grouped.pool_global_id) AS items
         FROM (
           SELECT warehouse.global_id AS warehouse_global_id,
                  pool.global_id AS pool_global_id,
                  sum(position.on_hand_quantity - position.reserved_quantity
                    - position.damaged_quantity) AS available_quantity
           FROM operations_inventory_positions position
           JOIN operations_warehouses warehouse
             ON warehouse.organization_id = position.organization_id
            AND warehouse.id = position.warehouse_id
           JOIN operations_inventory_pools pool
             ON pool.organization_id = position.organization_id
            AND pool.id = position.pool_id
           JOIN operations_locations location
             ON location.organization_id = position.organization_id
            AND location.id = position.location_id
           WHERE position.organization_id = $1::uuid
             AND position.pipeline_id = product.pipeline_id
             AND position.product_id = product.id
             AND position.source_authority = 'clawpilot'
             AND warehouse.status = 'active'
             AND pool.active = true
             AND location.active = true
           GROUP BY warehouse.global_id, pool.global_id
         ) grouped
         WHERE grouped.available_quantity > 0
       ) availability ON true
       WHERE product.pipeline_id = $2::uuid AND product.active = true
       ORDER BY lower(product.name), product.id
       LIMIT 1000`,
      [organizationId, resolvedActivation.pipeline_id],
    ),
    enabledCarriers(organizationId),
  ])
  const locationsByWarehouse = new Map<string, Array<{ globalId: string; code: string }>>()
  for (const location of locations.rows) {
    const current = locationsByWarehouse.get(location.warehouse_id) || []
    current.push({ globalId: location.global_id, code: location.code })
    locationsByWarehouse.set(location.warehouse_id, current)
  }
  const warehouseIds = await query<{ id: string; global_id: string }>(
    `SELECT id::text, global_id
     FROM operations_warehouses
     WHERE organization_id = $1::uuid AND status = 'active' AND code <> 'MOCK-01'`,
    [organizationId],
  )
  const idByGlobal = new Map(warehouseIds.rows.map((row) => [row.global_id, row.id]))
  return {
    environment: oneOffRateEnvironment(),
    customers: customers.rows.map((customer) => ({
      globalId: customer.global_id,
      name: customer.name,
    })),
    warehouses: warehouses.rows.map((warehouse) => ({
      globalId: warehouse.global_id,
      name: warehouse.name,
      address: workspaceAddress(warehouse.address),
      inventoryPools: pools.rows.map((pool) => ({
        globalId: pool.global_id,
        name: pool.name,
      })),
      receivingLocations: locationsByWarehouse.get(idByGlobal.get(warehouse.global_id) || '') || [],
    })),
    products: products.rows.map((product) => ({
      globalId: product.global_id,
      name: product.name,
      sku: product.sku,
      unitPriceMinor: numberValue(product.unit_price_minor),
      defaultPackage: product.profile_row_version === null
        ? null
        : {
            rowVersion: numberValue(product.profile_row_version),
            unitsPerPackage: numberValue(product.units_per_package),
            dimensionsMm: {
              length: numberValue(product.length_mm),
              width: numberValue(product.width_mm),
              height: numberValue(product.height_mm),
            },
            weightGrams: numberValue(product.weight_grams),
          },
      availability: (product.availability || []).map((item) => ({
        warehouseGlobalId: item.warehouseGlobalId,
        inventoryPoolGlobalId: item.inventoryPoolGlobalId,
        availableQuantity: numberValue(item.availableQuantity),
      })),
    })),
    carriers: carriers.map((carrier) => ({
      provider: carrier.provider,
      providerLabel: oneOffProviderLabel(carrier.provider),
      environment: 'sandbox',
      integrationAccountGlobalId: carrier.integrationAccountGlobalId,
      carrierAccountGlobalId: carrier.carrierAccountGlobalId,
      displayName: carrier.displayName,
      senderOriginWarehouseGlobalId: carrier.senderOriginWarehouseGlobalId,
    })),
  }
}

type ResolvedQuoteScope = {
  pipelineId: string
  customerId: string
  warehouseId: string
  poolId: string
  locationId: string
  linesSnapshot: ResolvedLineSnapshot[]
}

type ResolvedLineSnapshot = {
  kind: 'existing' | 'new'
  lineKey: string
  quantity: number
  productGlobalId?: string
  productId?: string
  productName: string
  sku: string
  unitPriceMinor: number
  unitWeightGrams: number
  unitDimensionsMm: Millimeters
  productSourceHash?: string
  packageProfileGlobalId?: string
  packageProfileRowVersion?: number
  inventorySnapshotHash?: string
  availableQuantityAtQuote?: number
  inventoryPositions?: Array<{
    globalId: string
    locationGlobalId: string
    version: number
    onHandQuantity: number
    reservedQuantity: number
    damagedQuantity: number
  }>
  physicalUnitsOnHandConfirmed?: true
  productSourceKey?: string
}

async function resolveQuoteScope(
  client: PoolClient,
  organizationId: string,
  quote: OneOffShipmentQuoteInput,
): Promise<ResolvedQuoteScope> {
  const resolvedActivation = await activation(client, organizationId)
  const customer = await client.query<{ id: string }>(
    `SELECT id::text
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid AND reference_code = $2
       AND COALESCE(lower(source_payload->>'archived'), 'false')
         NOT IN ('true', '1', 'yes')
     LIMIT 1`,
    [resolvedActivation.pipeline_id, quote.customerGlobalId],
  )
  if (!customer.rows[0]) {
    requestError('OPERATIONS_ONE_OFF_CUSTOMER_NOT_FOUND', 'Select an active CRM customer', 404)
  }
  const warehouse = await client.query<{ id: string }>(
    `SELECT id::text
     FROM operations_warehouses
     WHERE organization_id = $1::uuid AND global_id = $2 AND status = 'active'
       AND code <> 'MOCK-01'
     LIMIT 1`,
    [organizationId, quote.warehouseGlobalId],
  )
  if (!warehouse.rows[0]) {
    requestError('OPERATIONS_ONE_OFF_WAREHOUSE_NOT_FOUND', 'Select an active warehouse', 404)
  }
  const pool = await client.query<{
    id: string
    pool_type: 'shared' | 'customer_dedicated'
    owner_customer_id: string | null
  }>(
    `SELECT id::text, pool_type, owner_customer_id::text
     FROM operations_inventory_pools
     WHERE organization_id = $1::uuid AND pipeline_id = $2::uuid
       AND global_id = $3 AND active = true
     LIMIT 1`,
    [organizationId, resolvedActivation.pipeline_id, quote.inventoryPoolGlobalId],
  )
  if (!pool.rows[0]) {
    requestError('OPERATIONS_ONE_OFF_POOL_NOT_FOUND', 'Select an active inventory pool', 404)
  }
  if (
    pool.rows[0].pool_type === 'customer_dedicated'
    && pool.rows[0].owner_customer_id !== customer.rows[0].id
  ) {
    requestError(
      'OPERATIONS_ONE_OFF_POOL_CUSTOMER_MISMATCH',
      'The selected customer cannot use this dedicated inventory pool',
      409,
    )
  }
  const location = await client.query<{ id: string }>(
    `SELECT id::text
     FROM operations_locations
     WHERE organization_id = $1::uuid AND warehouse_id = $2::uuid
       AND global_id = $3 AND active = true
       AND location_type IN ('receiving', 'pick')
     LIMIT 1`,
    [organizationId, warehouse.rows[0].id, quote.receivingLocationGlobalId],
  )
  if (!location.rows[0]) {
    requestError(
      'OPERATIONS_ONE_OFF_LOCATION_NOT_FOUND',
      'Select an active receiving or pick location in this warehouse',
      404,
    )
  }
  const existingGlobalIds = quote.lines.flatMap((item) => (
    item.kind === 'existing' ? [item.productGlobalId] : []
  ))
  const products = existingGlobalIds.length
    ? await client.query<{
        id: string
        global_id: string
        name: string
        sku: string | null
        price_minor: string
        source_hash: string
        profile_global_id: string
        row_version: string
        units_per_package: number
        length_mm: number
        width_mm: number
        height_mm: number
        weight_grams: number
      }>(
        `SELECT product.id::text, product.reference_code AS global_id,
                product.name, NULLIF(btrim(product.sku), '') AS sku,
                round(COALESCE(product.price, 0) * 100)::bigint::text AS price_minor,
                product.source_hash, profile.global_id AS profile_global_id,
                profile.row_version::text,
                profile.units_per_package, profile.length_mm, profile.width_mm,
                profile.height_mm, profile.weight_grams
         FROM crm_products product
         JOIN LATERAL (
           SELECT candidate.*
           FROM operations_product_package_profiles candidate
           WHERE candidate.organization_id = $1::uuid
             AND candidate.pipeline_id = product.pipeline_id
             AND candidate.product_id = product.id
             AND candidate.active = true
           ORDER BY candidate.is_default DESC, candidate.updated_at DESC, candidate.id
           LIMIT 1
         ) profile ON true
         WHERE product.pipeline_id = $2::uuid
           AND product.reference_code = ANY($3::text[])
           AND product.active = true`,
        [organizationId, resolvedActivation.pipeline_id, existingGlobalIds],
      )
    : { rows: [] as Array<{
        id: string
        global_id: string
        name: string
        sku: string | null
        price_minor: string
        source_hash: string
        profile_global_id: string
        row_version: string
        units_per_package: number
        length_mm: number
        width_mm: number
        height_mm: number
        weight_grams: number
      }> }
  const productByGlobalId = new Map(products.rows.map((product) => [product.global_id, product]))
  if (productByGlobalId.size !== new Set(existingGlobalIds).size) {
    requestError(
      'OPERATIONS_ONE_OFF_PRODUCT_PROFILE_REQUIRED',
      'Every existing product needs an active default physical package profile',
      409,
    )
  }
  const newSkus = quote.lines.flatMap((item) => item.kind === 'new' ? [item.sku] : [])
  if (newSkus.length) {
    const newNames = quote.lines.flatMap((item) => item.kind === 'new' ? [item.name] : [])
    const collision = await client.query<{ sku: string | null; name: string }>(
      `SELECT sku, name
       FROM crm_products
       WHERE pipeline_id = $1::uuid
         AND (
           lower(btrim(sku)) = ANY($2::text[])
           OR lower(btrim(name)) = ANY($3::text[])
         )
       LIMIT 1`,
      [
        resolvedActivation.pipeline_id,
        newSkus.map((sku) => sku.toLowerCase()),
        newNames.map((name) => name.toLowerCase()),
      ],
    )
    if (collision.rows[0]) {
      requestError(
        'OPERATIONS_ONE_OFF_NEW_PRODUCT_SKU_EXISTS',
        `Product ${collision.rows[0].sku || collision.rows[0].name} already exists; select the existing product instead`,
        409,
      )
    }
  }
  const productIds = products.rows.map((product) => product.id)
  const inventory = productIds.length
    ? await client.query<{
        product_id: string
        global_id: string
        location_global_id: string
        version: string
        on_hand_quantity: string
        reserved_quantity: string
        damaged_quantity: string
      }>(
        `SELECT position.product_id::text, position.global_id,
                location.global_id AS location_global_id,
                position.version::text, position.on_hand_quantity::text,
                position.reserved_quantity::text, position.damaged_quantity::text
         FROM operations_inventory_positions position
         JOIN operations_locations location
           ON location.organization_id = position.organization_id
          AND location.id = position.location_id
         WHERE position.organization_id = $1::uuid
           AND position.pipeline_id = $2::uuid
           AND position.warehouse_id = $3::uuid
           AND position.pool_id = $4::uuid
           AND position.product_id = ANY($5::uuid[])
           AND position.source_authority = 'clawpilot'
           AND location.active = true
         ORDER BY position.product_id, location.pick_sequence,
                  position.created_at, position.id`,
        [
          organizationId,
          resolvedActivation.pipeline_id,
          warehouse.rows[0].id,
          pool.rows[0].id,
          productIds,
        ],
      )
    : { rows: [] as Array<{
        product_id: string
        global_id: string
        location_global_id: string
        version: string
        on_hand_quantity: string
        reserved_quantity: string
        damaged_quantity: string
      }> }
  const inventoryByProductId = new Map<string, ResolvedLineSnapshot['inventoryPositions']>()
  for (const position of inventory.rows) {
    const current = inventoryByProductId.get(position.product_id) || []
    current.push({
      globalId: position.global_id,
      locationGlobalId: position.location_global_id,
      version: numberValue(position.version),
      onHandQuantity: numberValue(position.on_hand_quantity),
      reservedQuantity: numberValue(position.reserved_quantity),
      damagedQuantity: numberValue(position.damaged_quantity),
    })
    inventoryByProductId.set(position.product_id, current)
  }
  const linesSnapshot = quote.lines.map((item): ResolvedLineSnapshot => {
    if (item.kind === 'new') {
      return {
        kind: item.kind,
        lineKey: item.lineKey,
        quantity: item.quantity,
        productName: item.name,
        sku: item.sku,
        unitPriceMinor: item.unitPriceMinor,
        unitWeightGrams: item.unitWeightGrams,
        unitDimensionsMm: item.unitDimensionsMm,
        physicalUnitsOnHandConfirmed: true,
        productSourceKey: `operations-one-off:${oneOffShipmentHash({
          referenceNumber: quote.referenceNumber,
          lineKey: item.lineKey,
          sku: item.sku,
        })}`,
      }
    }
    const product = productByGlobalId.get(item.productGlobalId)!
    const inventoryPositions = inventoryByProductId.get(product.id) || []
    const availableQuantityAtQuote = inventoryPositions.reduce((sum, position) => (
      sum + position.onHandQuantity - position.reservedQuantity - position.damagedQuantity
    ), 0)
    if (availableQuantityAtQuote < item.quantity) {
      requestError(
        'OPERATIONS_ONE_OFF_INVENTORY_INSUFFICIENT',
        `${product.name} has ${availableQuantityAtQuote} available in the selected warehouse and pool`,
        409,
      )
    }
    return {
      kind: item.kind,
      lineKey: item.lineKey,
      quantity: item.quantity,
      productGlobalId: product.global_id,
      productId: product.id,
      productName: product.name,
      sku: product.sku || product.global_id,
      unitPriceMinor: numberValue(product.price_minor),
      unitWeightGrams: Math.max(1, Math.ceil(product.weight_grams / product.units_per_package)),
      unitDimensionsMm: {
        length: product.length_mm,
        width: product.width_mm,
        height: product.height_mm,
      },
      productSourceHash: product.source_hash,
      packageProfileGlobalId: product.profile_global_id,
      packageProfileRowVersion: numberValue(product.row_version),
      inventoryPositions,
      inventorySnapshotHash: oneOffShipmentHash(inventoryPositions),
      availableQuantityAtQuote,
    }
  })
  const lineByKey = new Map(linesSnapshot.map((item) => [item.lineKey, item]))
  for (const shipmentPackage of quote.packages) {
    const allocatedUnitWeight = shipmentPackage.allocations.reduce((sum, allocation) => (
      sum + lineByKey.get(allocation.lineKey)!.unitWeightGrams * allocation.quantity
    ), 0)
    if (shipmentPackage.grossWeightGrams < allocatedUnitWeight) {
      requestError(
        'OPERATIONS_ONE_OFF_PARCEL_WEIGHT_INVALID',
        `Parcel ${shipmentPackage.packageKey} gross weight is below its allocated product weight`,
        409,
      )
    }
  }
  return {
    pipelineId: resolvedActivation.pipeline_id,
    customerId: customer.rows[0].id,
    warehouseId: warehouse.rows[0].id,
    poolId: pool.rows[0].id,
    locationId: location.rows[0].id,
    linesSnapshot,
  }
}

type QuoteCommandRow = QueryResultRow & {
  request_hash: string
  state: 'pending' | 'completed' | 'failed'
  quote_id: string | null
  error_code: string | null
  created_at: Date
}

async function prepareQuoteCommand(input: {
  organizationId: string
  idempotencyKey: string
  requestHash: string
  actorEmail: string
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:one-off-quote:${input.organizationId}:${input.idempotencyKey}`,
    )
    const existing = await client.query<QuoteCommandRow>(
      `SELECT request_hash, state, quote_id::text, error_code, created_at
       FROM operations_one_off_shipment_quote_commands
       WHERE organization_id = $1::uuid AND idempotency_key = $2
       FOR UPDATE`,
      [input.organizationId, input.idempotencyKey],
    )
    const row = existing.rows[0]
    if (row) {
      if (row.request_hash !== input.requestHash) {
        requestError(
          'OPERATIONS_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used with different quote data',
          409,
        )
      }
      if (row.state === 'completed') {
        return { quoteId: row.quote_id, completed: true, expired: false }
      }
      if (row.state === 'failed') {
        requestError(
          row.error_code || 'OPERATIONS_ONE_OFF_QUOTE_FAILED',
          'This quote attempt failed; submit a new idempotency key after correcting the issue',
          409,
        )
      }
      if (Date.now() - new Date(row.created_at).getTime() < COMMAND_RETRY_MS) {
        requestError(
          'OPERATIONS_COMMAND_IN_PROGRESS',
          'This one-off shipment quote is already being processed',
          409,
        )
      }
      await client.query(
        `UPDATE operations_one_off_shipment_quote_commands
         SET state = 'failed', error_code = 'OPERATIONS_COMMAND_EXPIRED',
             completed_at = now()
         WHERE organization_id = $1::uuid AND idempotency_key = $2
           AND state = 'pending'`,
        [input.organizationId, input.idempotencyKey],
      )
      return { quoteId: null, completed: false, expired: true }
    }
    await client.query(
      `INSERT INTO operations_one_off_shipment_quote_commands (
         organization_id, idempotency_key, request_hash, actor_email
       ) VALUES ($1::uuid, $2, $3, $4)`,
      [
        input.organizationId,
        input.idempotencyKey,
        input.requestHash,
        input.actorEmail,
      ],
    )
    return { quoteId: null, completed: false, expired: false }
  })
}

async function failQuoteCommand(input: {
  organizationId: string
  idempotencyKey: string
  error: unknown
}) {
  const code = input.error instanceof OneOffShipmentPersistenceError
    ? input.error.code
    : input.error instanceof CarrierIntegrationRequestError
      ? input.error.code
      : 'OPERATIONS_ONE_OFF_QUOTE_FAILED'
  try {
    await query(
      `UPDATE operations_one_off_shipment_quote_commands
       SET state = 'failed', error_code = $3,
           completed_at = now()
       WHERE organization_id = $1::uuid AND idempotency_key = $2
         AND state = 'pending'`,
      [input.organizationId, input.idempotencyKey, code.slice(0, 120)],
    )
  } catch {
    // The original quote failure remains authoritative.
  }
}

type QuoteRow = QueryResultRow & {
  id: string
  global_id: string
  reference_number: string
  status: 'succeeded' | 'partial' | 'failed'
  rate_environment: OneOffRateEnvironment
  required_carrier_providers: OneOffCarrierProvider[]
  expires_at: Date
}

type OfferRow = QueryResultRow & {
  global_id: string
  provider: OneOffCarrierProvider
  environment: OneOffRateEnvironment
  service_code: string
  service_name: string
  amount_minor: string
  currency: string
  transit_days: number | null
  estimated_delivery_at: Date | null
  rate_evidence_global_id: string
}

function quoteFromRows(row: QuoteRow, offers: OfferRow[]): OneOffShipmentQuote {
  return {
    globalId: row.global_id,
    referenceNumber: row.reference_number,
    status: row.status,
    environment: row.rate_environment,
    requiredCarrierProviders: row.required_carrier_providers,
    expiresAt: new Date(row.expires_at).toISOString(),
    offers: offers.map((offer) => ({
      globalId: offer.global_id,
      provider: offer.provider,
      providerLabel: oneOffProviderLabel(offer.provider),
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
    })),
    effects: {
      carrierRateReads: row.required_carrier_providers.length,
      inventoryWrites: 0,
      shipmentWrites: 0,
      labelCalls: 0,
      postagePurchases: 0,
    },
  }
}

async function readQuoteById(
  organizationId: string,
  quoteId: string,
): Promise<OneOffShipmentQuote> {
  const quote = await query<QuoteRow>(
    `SELECT id::text, global_id, reference_number, status, rate_environment,
            required_carrier_providers, expires_at
     FROM operations_one_off_shipment_quotes
     WHERE organization_id = $1::uuid AND id = $2::uuid
     LIMIT 1`,
    [organizationId, quoteId],
  )
  if (!quote.rows[0]) {
    requestError('OPERATIONS_ONE_OFF_QUOTE_NOT_FOUND', 'One-off shipment quote was not found', 404)
  }
  const offers = await query<OfferRow>(
    `SELECT global_id, provider, environment, service_code, service_name,
            amount_minor::text, currency, transit_days,
            estimated_delivery_at, rate_evidence_global_id
     FROM operations_one_off_shipment_quote_offers
     WHERE organization_id = $1::uuid AND quote_id = $2::uuid
     ORDER BY amount_minor, provider, service_code, id`,
    [organizationId, quoteId],
  )
  return quoteFromRows(quote.rows[0], offers.rows)
}

type ProviderAttempt = {
  carrier: EnabledCarrier
  status: 'succeeded' | 'failed'
  evidenceGlobalId: string | null
  errorCode: string | null
  rates: Array<{
    serviceCode: string
    serviceName: string
    amount: string
    currency: string
    rateType: string | null
    transitDays: number | null
    deliveryDate: string | null
  }>
  testedAt: string | null
}

async function attemptCarrierQuote(input: {
  organizationId: string
  actorEmail: string
  carrier: EnabledCarrier
  quote: OneOffShipmentQuoteInput
}): Promise<ProviderAttempt> {
  try {
    const result = await testCarrierSandboxShipmentRate({
      organizationId: input.organizationId,
      provider: input.carrier.provider,
      environment: 'sandbox',
      carrierAccountGlobalId: input.carrier.carrierAccountGlobalId,
      destination: carrierDestination(input.quote.shipTo),
      parcels: carrierParcels(input.quote.packages),
      actorEmail: input.actorEmail,
      requireFailureEvidence: true,
    })
    const evidenceGlobalId = String(result.evidenceGlobalId || '').trim()
    if (!evidenceGlobalId) {
      return {
        carrier: input.carrier,
        status: 'failed',
        evidenceGlobalId: null,
        errorCode: 'CARRIER_RATE_EVIDENCE_REQUIRED',
        rates: [],
        testedAt: result.testedAt,
      }
    }
    return {
      carrier: input.carrier,
      status: 'succeeded',
      evidenceGlobalId,
      errorCode: null,
      rates: result.rates,
      testedAt: result.testedAt,
    }
  } catch (error) {
    const carrierError = error instanceof CarrierIntegrationRequestError ? error : null
    return {
      carrier: input.carrier,
      status: 'failed',
      evidenceGlobalId: carrierError?.rateEvidenceGlobalId || null,
      errorCode: carrierError?.code || 'CARRIER_INTERNAL_ERROR',
      rates: [],
      testedAt: null,
    }
  }
}

export async function quoteOneOffShipmentInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  quote: unknown
}): Promise<OneOffShipmentQuote> {
  const organizationId = requireOrganizationId(input.organizationId)
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  if (oneOffRateEnvironment() !== 'sandbox') {
    requestError(
      'OPERATIONS_ONE_OFF_PRODUCTION_NOT_ENABLED',
      'Production one-off carrier rating is not enabled; use the development sandbox workflow',
      409,
    )
  }
  const quote = validateOneOffShipmentQuoteInput(input.quote)
  const requestHash = oneOffShipmentHash(quote)
  const command = await prepareQuoteCommand({
    organizationId,
    idempotencyKey,
    requestHash,
    actorEmail: input.actorEmail,
  })
  if (command.completed && command.quoteId) {
    return readQuoteById(organizationId, command.quoteId)
  }
  if (command.expired) {
    requestError(
      'OPERATIONS_COMMAND_EXPIRED',
      'The previous quote attempt expired safely; start a new rate attempt',
      409,
    )
  }
  try {
    const [scope, carriers] = await Promise.all([
      withTransaction((client) => resolveQuoteScope(client, organizationId, quote)),
      enabledCarriers(organizationId, quote.warehouseGlobalId),
    ])
    if (!carriers.length) {
      requestError(
        'OPERATIONS_ONE_OFF_CARRIER_REQUIRED',
        'Enable and verify a UPS or FedEx sandbox account for the selected warehouse',
        409,
      )
    }
    const attempts = await Promise.all(carriers.map((carrier) => attemptCarrierQuote({
      organizationId,
      actorEmail: input.actorEmail,
      carrier,
      quote,
    })))
    const evidenceGlobalIds = attempts.flatMap((attempt) => (
      attempt.evidenceGlobalId ? [attempt.evidenceGlobalId] : []
    ))
    const evidence = evidenceGlobalIds.length
      ? await query<{
          global_id: string
          provider: OneOffCarrierProvider
          integration_account_id: string
          carrier_account_id: string
          credential_version: number
          request_hash: string
          redacted_response: Record<string, unknown>
          status: 'succeeded' | 'failed'
        }>(
          `SELECT global_id, provider, integration_account_id::text,
                  carrier_account_id::text, credential_version,
                  request_hash, redacted_response, status
           FROM operations_carrier_rate_requests
           WHERE organization_id = $1::uuid
             AND global_id = ANY($2::text[])
             AND purpose = 'cartonization_shipment_rate'`,
          [organizationId, evidenceGlobalIds],
        )
      : { rows: [] as Array<{
          global_id: string
          provider: OneOffCarrierProvider
          integration_account_id: string
          carrier_account_id: string
          credential_version: number
          request_hash: string
          redacted_response: Record<string, unknown>
          status: 'succeeded' | 'failed'
        }> }
    const evidenceByGlobalId = new Map(evidence.rows.map((row) => [row.global_id, row]))
    const providerResults: Record<string, unknown> = {}
    const offerDrafts: Array<{
      carrier: EnabledCarrier
      rate: ProviderAttempt['rates'][number]
      amountMinor: number
      estimatedDeliveryAt: string
      evidenceGlobalId: string
      requestHash: string
      responseHash: string
    }> = []
    let successfulProviders = 0
    for (const attempt of attempts) {
      const rateEvidence = attempt.evidenceGlobalId
        ? evidenceByGlobalId.get(attempt.evidenceGlobalId)
        : null
      const evidenceMatches = Boolean(
        rateEvidence
        && rateEvidence.provider === attempt.carrier.provider
        && rateEvidence.integration_account_id === attempt.carrier.integrationAccountId
        && rateEvidence.carrier_account_id === attempt.carrier.carrierAccountId
        && rateEvidence.credential_version === attempt.carrier.credentialVersion
      )
      const eligibleRates = attempt.status === 'succeeded'
        && rateEvidence?.status === 'succeeded'
        && evidenceMatches
        ? attempt.rates.flatMap((rate) => {
            const amountMinor = rate.currency.toUpperCase() === quote.currency
              ? moneyMinor(rate.amount)
              : null
            const estimatedDeliveryAt = rateDelivery(
              attempt.testedAt || '',
              rate.deliveryDate,
              rate.transitDays,
            )
            return amountMinor === null || !estimatedDeliveryAt
              ? []
              : [{ rate, amountMinor, estimatedDeliveryAt }]
          })
        : []
      if (eligibleRates.length && rateEvidence && attempt.evidenceGlobalId) {
        successfulProviders += 1
        for (const eligible of eligibleRates) {
          offerDrafts.push({
            carrier: attempt.carrier,
            rate: eligible.rate,
            amountMinor: eligible.amountMinor,
            estimatedDeliveryAt: eligible.estimatedDeliveryAt,
            evidenceGlobalId: attempt.evidenceGlobalId,
            requestHash: rateEvidence.request_hash,
            responseHash: oneOffShipmentHash(rateEvidence.redacted_response),
          })
        }
      }
      providerResults[attempt.carrier.provider] = {
        status: eligibleRates.length ? 'succeeded' : 'failed',
        errorCode: eligibleRates.length
          ? null
          : attempt.errorCode || (
              evidenceMatches
                ? 'CARRIER_ELIGIBLE_RATE_UNAVAILABLE'
                : 'CARRIER_RATE_EVIDENCE_MISMATCH'
            ),
        integrationAccountGlobalId: attempt.carrier.integrationAccountGlobalId,
        carrierAccountGlobalId: attempt.carrier.carrierAccountGlobalId,
        credentialVersion: attempt.carrier.credentialVersion,
        rateEvidenceGlobalId: attempt.evidenceGlobalId,
        eligibleOfferCount: eligibleRates.length,
      }
    }
    const status: QuoteRow['status'] = successfulProviders === carriers.length
      ? 'succeeded'
      : successfulProviders > 0
        ? 'partial'
        : 'failed'
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString()
    const saved = await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:one-off-quote:${organizationId}:${idempotencyKey}`,
      )
      const command = await client.query<QuoteCommandRow>(
        `SELECT request_hash, state, quote_id::text, error_code, created_at
         FROM operations_one_off_shipment_quote_commands
         WHERE organization_id = $1::uuid AND idempotency_key = $2
         FOR UPDATE`,
        [organizationId, idempotencyKey],
      )
      if (!command.rows[0] || command.rows[0].state !== 'pending' || command.rows[0].request_hash !== requestHash) {
        requestError(
          'OPERATIONS_IDEMPOTENCY_CONFLICT',
          'The one-off quote command reservation changed before completion',
          409,
        )
      }
      const inserted = await client.query<QuoteRow>(
        `INSERT INTO operations_one_off_shipment_quotes (
           organization_id, pipeline_id, customer_id, warehouse_id,
           inventory_pool_id, receiving_location_id, rate_environment,
           reference_number, currency, requested_delivery_at,
           destination_snapshot, destination_hash,
           lines_snapshot, lines_hash, packages_snapshot, packages_hash,
           required_carrier_providers, provider_results_snapshot,
           request_hash, status, idempotency_key, actor_email, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, 'sandbox', $7, $8, $9::timestamptz,
           $10::jsonb, $11, $12::jsonb, $13, $14::jsonb, $15,
           $16::text[], $17::jsonb, $18, $19, $20, $21, $22::timestamptz
         )
         RETURNING id::text, global_id, reference_number, status,
                   rate_environment, required_carrier_providers, expires_at`,
        [
          organizationId,
          scope.pipelineId,
          scope.customerId,
          scope.warehouseId,
          scope.poolId,
          scope.locationId,
          quote.referenceNumber,
          quote.currency,
          quote.requestedDeliveryAt,
          JSON.stringify(quote.shipTo),
          oneOffShipmentHash(quote.shipTo),
          JSON.stringify(scope.linesSnapshot),
          oneOffShipmentHash(scope.linesSnapshot),
          JSON.stringify(quote.packages),
          oneOffShipmentHash(quote.packages),
          carriers.map((carrier) => carrier.provider),
          JSON.stringify(providerResults),
          requestHash,
          status,
          idempotencyKey,
          input.actorEmail,
          expiresAt,
        ],
      )
      const savedOffers: OfferRow[] = []
      for (const draft of offerDrafts) {
        const offer = await client.query<OfferRow>(
          `INSERT INTO operations_one_off_shipment_quote_offers (
             organization_id, quote_id, integration_account_id,
             carrier_account_id, provider, environment, credential_version,
             service_code, service_name, amount_minor, currency,
             transit_days, estimated_delivery_at, rate_evidence_global_id,
             carrier_request_hash, carrier_response_hash, offer_snapshot
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'sandbox', $6,
             $7, $8, $9, $10, $11, $12::timestamptz, $13, $14, $15,
             $16::jsonb
           )
           RETURNING global_id, provider, environment, service_code,
                     service_name, amount_minor::text, currency, transit_days,
                     estimated_delivery_at, rate_evidence_global_id`,
          [
            organizationId,
            inserted.rows[0].id,
            draft.carrier.integrationAccountId,
            draft.carrier.carrierAccountId,
            draft.carrier.provider,
            draft.carrier.credentialVersion,
            draft.rate.serviceCode,
            draft.rate.serviceName,
            draft.amountMinor,
            draft.rate.currency.toUpperCase(),
            draft.rate.transitDays,
            draft.estimatedDeliveryAt,
            draft.evidenceGlobalId,
            draft.requestHash,
            draft.responseHash,
            JSON.stringify({
              provider: draft.carrier.provider,
              serviceCode: draft.rate.serviceCode,
              serviceName: draft.rate.serviceName,
              amount: draft.rate.amount,
              currency: draft.rate.currency.toUpperCase(),
              rateType: draft.rate.rateType,
              transitDays: draft.rate.transitDays,
              deliveryDate: draft.rate.deliveryDate,
              estimatedDeliveryAt: draft.estimatedDeliveryAt,
              rateEvidenceGlobalId: draft.evidenceGlobalId,
            }),
          ],
        )
        savedOffers.push(offer.rows[0])
      }
      await client.query(
        `UPDATE operations_one_off_shipment_quote_commands
         SET state = 'completed', quote_id = $3::uuid,
             completed_at = now()
         WHERE organization_id = $1::uuid AND idempotency_key = $2`,
        [organizationId, idempotencyKey, inserted.rows[0].id],
      )
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.one_off_shipment.quote.sealed',
        aggregateType: 'operations.one_off_shipment_quote',
        aggregateId: inserted.rows[0].global_id,
        subject: quote.referenceNumber,
        organizationId,
        eventKey: `operations:one-off-quote:${inserted.rows[0].global_id}:sealed`,
        payload: {
          status,
          warehouseGlobalId: quote.warehouseGlobalId,
          customerGlobalId: quote.customerGlobalId,
          requiredCarrierProviders: carriers.map((carrier) => carrier.provider),
          offerCount: savedOffers.length,
          expiresAt,
          effects: {
            carrierRateReads: carriers.length,
            inventoryWrites: 0,
            shipmentWrites: 0,
            labelCalls: 0,
            postagePurchases: 0,
          },
        },
      }, client)
      return quoteFromRows(inserted.rows[0], savedOffers)
    })
    return saved
  } catch (error) {
    await failQuoteCommand({ organizationId, idempotencyKey, error })
    throw error
  }
}

type CommandReceiptRow = QueryResultRow & {
  id: string
  request_hash: string
  target_global_id: string | null
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_global_id: string | null
  result_payload: Record<string, unknown> | null
  updated_at: Date
}

function replayedCreateResult(payload: Record<string, unknown> | null): OneOffShipmentCreateResult {
  if (!payload) {
    requestError(
      'OPERATIONS_COMMAND_RESULT_MISSING',
      'The completed one-off shipment command has no durable result',
      500,
    )
  }
  const createdProductGlobalIds = Array.isArray(payload.createdProductGlobalIds)
    ? payload.createdProductGlobalIds.map(String)
    : []
  const result: OneOffShipmentCreateResult = {
    orderGlobalId: String(payload.orderGlobalId || ''),
    orderStatus: 'planned',
    rowVersion: Number(payload.rowVersion),
    fulfillmentPlanGlobalId: String(payload.fulfillmentPlanGlobalId || ''),
    quoteGlobalId: String(payload.quoteGlobalId || ''),
    selectedOfferGlobalId: String(payload.selectedOfferGlobalId || ''),
    createdProductGlobalIds,
    receiptGlobalId: payload.receiptGlobalId === null
      ? null
      : String(payload.receiptGlobalId || ''),
    packageCount: Number(payload.packageCount),
    replayed: true,
  }
  if (
    !/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(result.orderGlobalId)
    || !/^gfp(?:[0-9]{7}|[0-9a-v]{12})$/.test(result.fulfillmentPlanGlobalId)
    || !QUOTE_GLOBAL_ID.test(result.quoteGlobalId)
    || !OFFER_GLOBAL_ID.test(result.selectedOfferGlobalId)
    || !Number.isSafeInteger(result.rowVersion)
    || result.rowVersion < 0
    || !Number.isSafeInteger(result.packageCount)
    || result.packageCount < 1
  ) {
    requestError(
      'OPERATIONS_COMMAND_RESULT_INVALID',
      'The completed one-off shipment command result is invalid',
      500,
    )
  }
  return result
}

async function prepareCreateCommand(input: {
  organizationId: string
  idempotencyKey: string
  requestHash: string
  quoteGlobalId: string
  actorEmail: string
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:command-receipt:${input.organizationId}:create_one_off_shipment:${input.idempotencyKey}`,
    )
    const existing = await client.query<CommandReceiptRow>(
      `SELECT id::text, request_hash, target_global_id, status,
              correlation_id::text, result_global_id, result_payload, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'create_one_off_shipment'
         AND idempotency_key = $2
       FOR UPDATE`,
      [input.organizationId, input.idempotencyKey],
    )
    const row = existing.rows[0]
    if (row) {
      if (row.request_hash !== input.requestHash || row.target_global_id !== input.quoteGlobalId) {
        requestError(
          'OPERATIONS_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for different one-off shipment data',
          409,
        )
      }
      if (row.status === 'succeeded') {
        return { receipt: row, completed: replayedCreateResult(row.result_payload) }
      }
      if (
        row.status === 'processing'
        && Date.now() - new Date(row.updated_at).getTime() < COMMAND_RETRY_MS
      ) {
        requestError(
          'OPERATIONS_COMMAND_IN_PROGRESS',
          'This one-off shipment is already being created',
          409,
        )
      }
      const retried = await client.query<CommandReceiptRow>(
        `UPDATE operations_command_receipts
         SET status = 'processing', actor_email = $2, attempts = attempts + 1,
             error_code = NULL, error_message = NULL, completed_at = NULL,
             started_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text, request_hash, target_global_id, status,
                   correlation_id::text, result_global_id, result_payload, updated_at`,
        [row.id, input.actorEmail],
      )
      return { receipt: retried.rows[0], completed: null }
    }
    const created = await client.query<CommandReceiptRow>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id, target_global_id
       ) VALUES (
         $1::uuid, 'create_one_off_shipment', $2, $3,
         $4, 'processing', $5::uuid, $6
       )
       RETURNING id::text, request_hash, target_global_id, status,
                 correlation_id::text, result_global_id, result_payload, updated_at`,
      [
        input.organizationId,
        input.idempotencyKey,
        input.requestHash,
        input.actorEmail,
        randomUUID(),
        input.quoteGlobalId,
      ],
    )
    return { receipt: created.rows[0], completed: null }
  })
}

async function failCreateCommand(receiptId: string, error: unknown) {
  const code = error instanceof OneOffShipmentPersistenceError
    ? error.code
    : 'OPERATIONS_ONE_OFF_CREATE_FAILED'
  const message = error instanceof Error
    ? error.message.slice(0, 500)
    : 'One-off shipment creation failed'
  try {
    await query(
      `UPDATE operations_command_receipts
       SET status = 'failed', error_code = $2, error_message = $3,
           completed_at = now(), updated_at = now()
       WHERE id = $1::uuid AND status = 'processing'`,
      [receiptId, code, message],
    )
  } catch {
    // Preserve the original command failure if receipt persistence also fails.
  }
}

type LockedQuoteRow = QueryResultRow & {
  id: string
  global_id: string
  pipeline_id: string
  customer_id: string
  warehouse_id: string
  inventory_pool_id: string
  receiving_location_id: string
  rate_environment: OneOffRateEnvironment
  reference_number: string
  currency: string
  requested_delivery_at: Date | null
  destination_snapshot: Address
  lines_snapshot: ResolvedLineSnapshot[]
  packages_snapshot: OneOffShipmentPackageInput[]
  status: 'succeeded' | 'partial' | 'failed'
  expires_at: Date
}

type LockedOfferRow = QueryResultRow & {
  id: string
  global_id: string
  integration_account_id: string
  carrier_account_id: string
  provider: OneOffCarrierProvider
  environment: OneOffRateEnvironment
  credential_version: number
  service_code: string
  service_name: string
  amount_minor: string
  currency: string
  transit_days: number | null
  estimated_delivery_at: Date | null
  rate_evidence_global_id: string
  offer_snapshot: Record<string, unknown>
}

async function appendDomainEvent(
  client: PoolClient,
  input: {
    organizationId: string
    aggregateType: string
    aggregateId: string
    aggregateGlobalId: string
    eventType: string
    actorEmail: string
    correlationId: string
    idempotencyKey: string
    payload: Record<string, unknown>
  },
) {
  await client.query(
    `INSERT INTO operations_domain_events (
       organization_id, aggregate_type, aggregate_id, aggregate_global_id,
       event_type, event_version, payload, actor_email, correlation_id,
       idempotency_key
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4, $5, 1, $6::jsonb, $7, $8::uuid, $9
     )`,
    [
      input.organizationId,
      input.aggregateType,
      input.aggregateId,
      input.aggregateGlobalId,
      input.eventType,
      JSON.stringify(input.payload),
      input.actorEmail,
      input.correlationId,
      input.idempotencyKey,
    ],
  )
}

type CreatedProduct = {
  id: string
  globalId: string
  name: string
  sku: string
  unitPriceMinor: number
  unitWeightGrams: number
  unitDimensionsMm: Millimeters
  positionId?: string
  positionGlobalId?: string
}

type InventoryPosition = {
  id: string
  global_id: string
  location_id: string
  location_global_id: string
  version: string
  on_hand_quantity: string
  reserved_quantity: string
  damaged_quantity: string
}

function inventoryPositionSnapshot(rows: InventoryPosition[]) {
  return rows.map((position) => ({
    globalId: position.global_id,
    locationGlobalId: position.location_global_id,
    version: numberValue(position.version),
    onHandQuantity: numberValue(position.on_hand_quantity),
    reservedQuantity: numberValue(position.reserved_quantity),
    damagedQuantity: numberValue(position.damaged_quantity),
  }))
}

async function createNewProductsAndReceipt(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    correlationId: string
    quote: LockedQuoteRow
    lines: ResolvedLineSnapshot[]
  },
) {
  const newLines = input.lines.filter((line) => line.kind === 'new')
  if (!newLines.length) {
    return {
      products: new Map<string, CreatedProduct>(),
      receiptId: null as string | null,
      receiptGlobalId: null as string | null,
    }
  }
  const products = new Map<string, CreatedProduct>()
  for (const shipmentLine of newLines) {
    if (
      shipmentLine.physicalUnitsOnHandConfirmed !== true
      || !shipmentLine.productSourceKey
    ) {
      requestError(
        'OPERATIONS_ONE_OFF_PHYSICAL_UNITS_REQUIRED',
        `New product line ${shipmentLine.lineKey} lacks physical-unit evidence`,
        409,
      )
    }
    const skuCollision = await client.query<{
      reference_code: string
      name: string
      sku: string | null
    }>(
      `SELECT reference_code, name, sku
       FROM crm_products
       WHERE pipeline_id = $1::uuid
         AND (
           lower(btrim(sku)) = lower($2)
           OR lower(btrim(name)) = lower($3)
         )
       LIMIT 1
       FOR UPDATE`,
      [input.quote.pipeline_id, shipmentLine.sku, shipmentLine.productName],
    )
    if (skuCollision.rows[0]) {
      requestError(
        'OPERATIONS_ONE_OFF_NEW_PRODUCT_SKU_EXISTS',
        `Product ${skuCollision.rows[0].sku || skuCollision.rows[0].name} now exists; select it as an existing product and refresh the quote`,
        409,
      )
    }
    const staged = await stageCrmRecordWithClient(client, {
      pipelineId: input.quote.pipeline_id,
      entity: 'products',
      sourceKey: `operations-one-off:${input.quote.global_id}:${shipmentLine.lineKey}`,
      actorEmail: input.actorEmail,
      fields: {
        name: shipmentLine.productName,
        sku: shipmentLine.sku,
        productType: 'Good',
        category: 'One-off shipment',
        status: 'Active',
        price: shipmentLine.unitPriceMinor / 100,
        currency: input.quote.currency,
        active: true,
        description: `Created from audited one-off shipment quote ${input.quote.global_id}`,
      },
      sourcePayload: {
        source: 'clawpilot_native',
        oneOffShipmentQuoteGlobalId: input.quote.global_id,
        lineKey: shipmentLine.lineKey,
        physicalUnitsOnHandConfirmed: true,
      },
    })
    const packageProfile = await upsertProductPackagingProfileWithClient(client, {
      organizationId: input.organizationId,
      pipelineId: input.quote.pipeline_id,
      productId: staged.id,
      actorEmail: input.actorEmail,
      profile: {
        profileName: 'One-off confirmed each',
        packageType: 'each',
        unitOfMeasure: 'each',
        unitsPerPackage: 1,
        measurementSystem: 'metric',
        lengthMm: shipmentLine.unitDimensionsMm.length,
        widthMm: shipmentLine.unitDimensionsMm.width,
        heightMm: shipmentLine.unitDimensionsMm.height,
        weightGrams: shipmentLine.unitWeightGrams,
        active: true,
        source: 'manual',
      },
    })
    products.set(shipmentLine.lineKey, {
      id: staged.id,
      globalId: staged.referenceCode,
      name: shipmentLine.productName,
      sku: shipmentLine.sku,
      unitPriceMinor: shipmentLine.unitPriceMinor,
      unitWeightGrams: shipmentLine.unitWeightGrams,
      unitDimensionsMm: shipmentLine.unitDimensionsMm,
    })
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.one_off_shipment.product.created',
      aggregateType: 'crm_product',
      aggregateId: staged.referenceCode,
      subject: shipmentLine.productName,
      organizationId: input.organizationId,
      eventKey: `operations:one-off:${input.quote.global_id}:product:${staged.referenceCode}`,
      payload: {
        quoteGlobalId: input.quote.global_id,
        lineKey: shipmentLine.lineKey,
        sku: shipmentLine.sku,
        quantity: shipmentLine.quantity,
        packageProfileGlobalId: packageProfile.globalId,
        packageProfileRowVersion: packageProfile.rowVersion,
        physicalUnitsOnHandConfirmed: true,
      },
    }, client)
  }
  const receipt = await client.query<{ id: string; global_id: string }>(
    `INSERT INTO operations_receipts (
       organization_id, pipeline_id, warehouse_id, inventory_pool_id,
       reference_number, status, expected_at, started_at, completed_at,
       row_version, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5, 'completed', now(), now(), now(), 1, $6, $6
     )
     RETURNING id::text, global_id`,
    [
      input.organizationId,
      input.quote.pipeline_id,
      input.quote.warehouse_id,
      input.quote.inventory_pool_id,
      `ONE-OFF-${input.quote.global_id}`,
      input.actorEmail,
    ],
  )
  for (const [index, shipmentLine] of newLines.entries()) {
    const product = products.get(shipmentLine.lineKey)!
    const receiptLine = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_receipt_lines (
         organization_id, receipt_id, pipeline_id, product_id,
         target_location_id, line_number, expected_quantity,
         accepted_quantity, damaged_quantity, lot_code, unit_of_measure
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6, $7, $7, 0, '', 'each'
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        receipt.rows[0].id,
        input.quote.pipeline_id,
        product.id,
        input.quote.receiving_location_id,
        index + 1,
        shipmentLine.quantity,
      ],
    )
    const position = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_inventory_positions (
         organization_id, pipeline_id, warehouse_id, location_id, pool_id,
         product_id, lot_code, source_authority
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, '', 'clawpilot'
       )
       ON CONFLICT (
         organization_id, warehouse_id, location_id, pool_id, product_id, lot_code
       ) DO UPDATE SET updated_at = operations_inventory_positions.updated_at
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        input.quote.pipeline_id,
        input.quote.warehouse_id,
        input.quote.receiving_location_id,
        input.quote.inventory_pool_id,
        product.id,
      ],
    )
    const balance = await client.query<{
      on_hand_quantity: string
      reserved_quantity: string
      damaged_quantity: string
    }>(
      `SELECT on_hand_quantity::text, reserved_quantity::text,
              damaged_quantity::text
       FROM operations_inventory_positions
       WHERE organization_id = $1::uuid AND id = $2::uuid
       FOR UPDATE`,
      [input.organizationId, position.rows[0].id],
    )
    const onHandAfter = numberValue(balance.rows[0].on_hand_quantity) + shipmentLine.quantity
    const reservedAfter = numberValue(balance.rows[0].reserved_quantity)
    const damagedAfter = numberValue(balance.rows[0].damaged_quantity)
    await client.query(
      `UPDATE operations_inventory_positions
       SET on_hand_quantity = $3, version = version + 1, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, position.rows[0].id, onHandAfter],
    )
    await client.query(
      `INSERT INTO operations_inventory_ledger (
         organization_id, position_id, event_type,
         on_hand_delta, reserved_delta, damaged_delta,
         on_hand_after, reserved_after, damaged_after,
         source_global_id, reason, idempotency_key, actor_email,
         source_authority
       ) VALUES (
         $1::uuid, $2::uuid, 'receipt', $3, 0, 0,
         $4, $5, $6, $7, $8, $9, $10, 'clawpilot'
       )`,
      [
        input.organizationId,
        position.rows[0].id,
        shipmentLine.quantity,
        onHandAfter,
        reservedAfter,
        damagedAfter,
        receiptLine.rows[0].global_id,
        `Physical units confirmed for one-off shipment ${input.quote.global_id}`,
        `${input.quote.global_id}:${shipmentLine.lineKey}:receipt`,
        input.actorEmail,
      ],
    )
    product.positionId = position.rows[0].id
    product.positionGlobalId = position.rows[0].global_id
  }
  await appendDomainEvent(client, {
    organizationId: input.organizationId,
    aggregateType: 'operations.receipt',
    aggregateId: receipt.rows[0].id,
    aggregateGlobalId: receipt.rows[0].global_id,
    eventType: 'operations.receipt.completed',
    actorEmail: input.actorEmail,
    correlationId: input.correlationId,
    idempotencyKey: `${input.quote.global_id}:one-off-receipt-completed`,
    payload: {
      quoteGlobalId: input.quote.global_id,
      lineCount: newLines.length,
      acceptedQuantity: newLines.reduce((sum, line) => sum + line.quantity, 0),
      damagedQuantity: 0,
      physicalUnitsOnHandConfirmed: true,
    },
  })
  await recordAuditEvent({
    actor: input.actorEmail,
    eventType: 'operations.receipt.completed',
    aggregateType: 'operations.receipt',
    aggregateId: receipt.rows[0].global_id,
    subject: `ONE-OFF-${input.quote.global_id}`,
    organizationId: input.organizationId,
    eventKey: `operations:one-off:${input.quote.global_id}:receipt-completed`,
    payload: {
      quoteGlobalId: input.quote.global_id,
      productGlobalIds: [...products.values()].map((product) => product.globalId),
      acceptedQuantity: newLines.reduce((sum, line) => sum + line.quantity, 0),
      physicalUnitsOnHandConfirmed: true,
    },
  }, client)
  return {
    products,
    receiptId: receipt.rows[0].id,
    receiptGlobalId: receipt.rows[0].global_id,
  }
}

async function lockExistingProductForCreate(
  client: PoolClient,
  input: {
    organizationId: string
    quote: LockedQuoteRow
    line: ResolvedLineSnapshot
  },
) {
  const line = input.line
  if (
    !line.productGlobalId
    || !line.productId
    || !line.productSourceHash
    || !line.packageProfileGlobalId
    || line.packageProfileRowVersion === undefined
    || !line.inventorySnapshotHash
    || !line.inventoryPositions
  ) {
    requestError(
      'OPERATIONS_ONE_OFF_QUOTE_SNAPSHOT_INVALID',
      `Existing product line ${line.lineKey} has incomplete quote evidence`,
      409,
    )
  }
  const product = await client.query<{
    id: string
    global_id: string
    name: string
    sku: string | null
    source_hash: string
    profile_global_id: string
    row_version: string
  }>(
    `SELECT product.id::text, product.reference_code AS global_id,
            product.name, NULLIF(btrim(product.sku), '') AS sku,
            product.source_hash, profile.global_id AS profile_global_id,
            profile.row_version::text
     FROM crm_products product
     JOIN operations_product_package_profiles profile
       ON profile.organization_id = $1::uuid
      AND profile.pipeline_id = product.pipeline_id
      AND profile.product_id = product.id
      AND profile.global_id = $4
      AND profile.active = true
     WHERE product.pipeline_id = $2::uuid
       AND product.id = $3::uuid
       AND product.reference_code = $5
       AND product.active = true
     FOR UPDATE OF product, profile`,
    [
      input.organizationId,
      input.quote.pipeline_id,
      line.productId,
      line.packageProfileGlobalId,
      line.productGlobalId,
    ],
  )
  const currentProduct = product.rows[0]
  if (
    !currentProduct
    || currentProduct.source_hash !== line.productSourceHash
    || numberValue(currentProduct.row_version) !== line.packageProfileRowVersion
  ) {
    requestError(
      'OPERATIONS_ONE_OFF_QUOTE_STALE',
      `${line.productName} or its physical package profile changed; request a new quote`,
      409,
    )
  }
  const positions = await client.query<InventoryPosition>(
    `SELECT position.id::text, position.global_id,
            position.location_id::text, location.global_id AS location_global_id,
            position.version::text, position.on_hand_quantity::text,
            position.reserved_quantity::text, position.damaged_quantity::text
     FROM operations_inventory_positions position
     JOIN operations_locations location
       ON location.organization_id = position.organization_id
      AND location.id = position.location_id
     WHERE position.organization_id = $1::uuid
       AND position.pipeline_id = $2::uuid
       AND position.warehouse_id = $3::uuid
       AND position.pool_id = $4::uuid
       AND position.product_id = $5::uuid
       AND position.source_authority = 'clawpilot'
       AND location.active = true
     ORDER BY position.product_id, location.pick_sequence,
              position.created_at, position.id
     FOR UPDATE OF position`,
    [
      input.organizationId,
      input.quote.pipeline_id,
      input.quote.warehouse_id,
      input.quote.inventory_pool_id,
      line.productId,
    ],
  )
  const snapshot = inventoryPositionSnapshot(positions.rows)
  if (oneOffShipmentHash(snapshot) !== line.inventorySnapshotHash) {
    requestError(
      'OPERATIONS_ONE_OFF_QUOTE_STALE',
      `${line.productName} inventory changed after rating; request a new quote`,
      409,
    )
  }
  const available = snapshot.reduce((sum, position) => (
    sum + position.onHandQuantity - position.reservedQuantity - position.damagedQuantity
  ), 0)
  if (available < line.quantity) {
    requestError(
      'OPERATIONS_ONE_OFF_INVENTORY_INSUFFICIENT',
      `${line.productName} no longer has enough local inventory`,
      409,
    )
  }
  return {
    product: {
      id: currentProduct.id,
      globalId: currentProduct.global_id,
      name: currentProduct.name,
      sku: currentProduct.sku || currentProduct.global_id,
      unitPriceMinor: line.unitPriceMinor,
      unitWeightGrams: line.unitWeightGrams,
      unitDimensionsMm: line.unitDimensionsMm,
    } satisfies CreatedProduct,
    positions: positions.rows,
  }
}

export async function createAndPlanOneOffShipmentInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  quoteGlobalId: string
  selectedOfferGlobalId: string
  reason: string
}): Promise<OneOffShipmentCreateResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const quoteGlobalId = globalId(input.quoteGlobalId, 'One-off shipment quote', QUOTE_GLOBAL_ID)
  const selectedOfferGlobalId = globalId(
    input.selectedOfferGlobalId,
    'One-off shipment offer',
    OFFER_GLOBAL_ID,
  )
  const reason = text(input.reason, 'Planning reason', 500, 3)
  const requestHash = oneOffShipmentHash({
    quoteGlobalId,
    selectedOfferGlobalId,
    reason,
  })
  const command = await prepareCreateCommand({
    organizationId,
    idempotencyKey,
    requestHash,
    quoteGlobalId,
    actorEmail: input.actorEmail,
  })
  if (command.completed) return command.completed
  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(client, `operations:activation:${organizationId}`)
      const active = await activation(client, organizationId, true)
      if (active.state !== 'shadow') {
        requestError(
          active.state === 'active'
            ? 'OPERATIONS_ONE_OFF_ACTIVE_PRODUCTION_EVIDENCE_REQUIRED'
            : 'OPERATIONS_ONE_OFF_SHADOW_REQUIRED',
          active.state === 'active'
            ? 'Active Operations requires sealed production planning evidence; create sandbox one-off shipments in Shadow'
            : 'One-off shipment creation is enabled only while Operations is in Shadow',
          409,
        )
      }
      const quoteResult = await client.query<LockedQuoteRow>(
        `SELECT id::text, global_id, pipeline_id::text, customer_id::text,
                warehouse_id::text, inventory_pool_id::text,
                receiving_location_id::text, rate_environment,
                reference_number, currency, requested_delivery_at,
                destination_snapshot, lines_snapshot, packages_snapshot,
                status, expires_at
         FROM operations_one_off_shipment_quotes
         WHERE organization_id = $1::uuid AND global_id = $2
         LIMIT 1
         FOR UPDATE`,
        [organizationId, quoteGlobalId],
      )
      const quote = quoteResult.rows[0]
      if (!quote) {
        requestError('OPERATIONS_ONE_OFF_QUOTE_NOT_FOUND', 'One-off shipment quote was not found', 404)
      }
      if (quote.rate_environment !== 'sandbox') {
        requestError(
          'OPERATIONS_ONE_OFF_PRODUCTION_NOT_ENABLED',
          'This safe one-off shipment slice accepts sandbox quotes only',
          409,
        )
      }
      if (quote.status === 'failed') {
        requestError(
          'OPERATIONS_ONE_OFF_QUOTE_FAILED',
          'A failed carrier quote cannot create a shipment plan',
          409,
        )
      }
      if (new Date(quote.expires_at).getTime() <= Date.now()) {
        requestError(
          'OPERATIONS_ONE_OFF_QUOTE_EXPIRED',
          'The carrier quote expired; request current rates',
          409,
        )
      }
      if (quote.pipeline_id !== active.pipeline_id) {
        requestError(
          'OPERATIONS_ONE_OFF_QUOTE_STALE',
          'The authoritative Operations pipeline changed; request a new quote',
          409,
        )
      }
      const alreadyConsumed = await client.query<{ order_global_id: string }>(
        `SELECT orders.global_id AS order_global_id
         FROM operations_one_off_shipment_quote_consumptions consumption
         JOIN operations_orders orders
           ON orders.organization_id = consumption.organization_id
          AND orders.id = consumption.order_id
         WHERE consumption.organization_id = $1::uuid
           AND consumption.quote_id = $2::uuid
         LIMIT 1
         FOR UPDATE OF consumption`,
        [organizationId, quote.id],
      )
      if (alreadyConsumed.rows[0]) {
        requestError(
          'OPERATIONS_ONE_OFF_QUOTE_CONSUMED',
          `This quote already created ${alreadyConsumed.rows[0].order_global_id}`,
          409,
        )
      }
      const offersResult = await client.query<LockedOfferRow>(
        `SELECT offer.id::text, offer.global_id,
                offer.integration_account_id::text,
                offer.carrier_account_id::text, offer.provider,
                offer.environment, offer.credential_version,
                offer.service_code, offer.service_name,
                offer.amount_minor::text, offer.currency, offer.transit_days,
                offer.estimated_delivery_at, offer.rate_evidence_global_id,
                offer.offer_snapshot
         FROM operations_one_off_shipment_quote_offers offer
         JOIN operations_carrier_rate_requests evidence
           ON evidence.organization_id = offer.organization_id
          AND evidence.global_id = offer.rate_evidence_global_id
          AND evidence.integration_account_id = offer.integration_account_id
          AND evidence.carrier_account_id = offer.carrier_account_id
          AND evidence.provider = offer.provider
          AND evidence.environment = offer.environment
          AND evidence.credential_version = offer.credential_version
          AND evidence.purpose = 'cartonization_shipment_rate'
          AND evidence.status = 'succeeded'
         JOIN operations_integration_accounts integration
           ON integration.organization_id = offer.organization_id
          AND integration.id = offer.integration_account_id
          AND integration.status = 'active'
          AND integration.environment = offer.environment
          AND integration.provider = offer.provider
         JOIN operations_carrier_accounts carrier_account
           ON carrier_account.organization_id = offer.organization_id
          AND carrier_account.integration_account_id = offer.integration_account_id
          AND carrier_account.id = offer.carrier_account_id
          AND carrier_account.status = 'active'
          AND carrier_account.allow_sender_billing = true
         WHERE offer.organization_id = $1::uuid
           AND offer.quote_id = $2::uuid
         ORDER BY offer.amount_minor, offer.provider, offer.service_code, offer.id
         FOR UPDATE OF offer`,
        [organizationId, quote.id],
      )
      const selectedOffer = offersResult.rows.find((offer) => (
        offer.global_id === selectedOfferGlobalId
      ))
      if (!selectedOffer) {
        requestError(
          'OPERATIONS_ONE_OFF_OFFER_UNAVAILABLE',
          'The selected carrier offer is not active evidence for this quote',
          409,
        )
      }
      if (
        selectedOffer.environment !== 'sandbox'
        || selectedOffer.currency !== quote.currency
        || !selectedOffer.estimated_delivery_at
      ) {
        requestError(
          'OPERATIONS_ONE_OFF_OFFER_INVALID',
          'The selected carrier offer cannot become a canonical plan',
          409,
        )
      }
      const scopeState = await client.query<{ ok: boolean }>(
        `SELECT true AS ok
         FROM crm_organizations customer
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = $1::uuid
          AND warehouse.id = $3::uuid
          AND warehouse.status = 'active'
         JOIN operations_inventory_pools pool
           ON pool.organization_id = $1::uuid
          AND pool.pipeline_id = $2::uuid
          AND pool.id = $4::uuid
          AND pool.active = true
          AND (
            pool.pool_type = 'shared'
            OR pool.owner_customer_id = $5::uuid
          )
         JOIN operations_locations location
           ON location.organization_id = $1::uuid
          AND location.warehouse_id = warehouse.id
          AND location.id = $6::uuid
          AND location.active = true
          AND location.location_type IN ('receiving', 'pick')
         WHERE customer.pipeline_id = $2::uuid AND customer.id = $5::uuid
         LIMIT 1
         FOR UPDATE OF customer, warehouse, pool, location`,
        [
          organizationId,
          quote.pipeline_id,
          quote.warehouse_id,
          quote.inventory_pool_id,
          quote.customer_id,
          quote.receiving_location_id,
        ],
      )
      if (!scopeState.rows[0]) {
        requestError(
          'OPERATIONS_ONE_OFF_QUOTE_STALE',
          'The customer, warehouse, inventory pool, or location changed; request a new quote',
          409,
        )
      }
      if (!Array.isArray(quote.lines_snapshot) || !Array.isArray(quote.packages_snapshot)) {
        requestError(
          'OPERATIONS_ONE_OFF_QUOTE_SNAPSHOT_INVALID',
          'The immutable one-off shipment snapshot is invalid',
          409,
        )
      }
      const existingProducts = new Map<string, {
        product: CreatedProduct
        positions: InventoryPosition[]
      }>()
      for (const shipmentLine of quote.lines_snapshot) {
        if (shipmentLine.kind !== 'existing') continue
        existingProducts.set(shipmentLine.lineKey, await lockExistingProductForCreate(client, {
          organizationId,
          quote,
          line: shipmentLine,
        }))
      }
      const newProductResult = await createNewProductsAndReceipt(client, {
        organizationId,
        actorEmail: input.actorEmail,
        correlationId: command.receipt.correlation_id,
        quote,
        lines: quote.lines_snapshot,
      })
      await acquireTransactionAdvisoryLock(
        client,
        `operations:native-integration:${organizationId}:sandbox`,
      )
      await client.query(
        `INSERT INTO operations_integration_accounts (
           organization_id, provider, integration_type, environment,
           display_name, status, configuration, created_by, updated_by
         ) VALUES (
           $1::uuid, 'clawpilot_native', 'commerce', 'sandbox',
           'ClawPilot native one-off shipments', 'active', $2::jsonb, $3, $3
         )
         ON CONFLICT (organization_id, integration_type, provider, environment)
         DO NOTHING`,
        [
          organizationId,
          JSON.stringify({
            sourceAuthority: 'clawpilot',
            oneOffShipmentMvp: true,
            labelPurchaseEnabled: false,
          }),
          input.actorEmail,
        ],
      )
      const nativeIntegration = await client.query<{
        id: string
        global_id: string
        status: 'active' | 'disabled' | 'error'
      }>(
        `SELECT id::text, global_id, status
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid
           AND integration_type = 'commerce'
           AND provider = 'clawpilot_native'
           AND environment = 'sandbox'
         LIMIT 1
         FOR UPDATE`,
        [organizationId],
      )
      if (!nativeIntegration.rows[0] || nativeIntegration.rows[0].status !== 'active') {
        requestError(
          'OPERATIONS_ONE_OFF_NATIVE_SOURCE_UNAVAILABLE',
          'The native ClawPilot one-off order source is unavailable',
          409,
        )
      }
      const merchandiseTotal = quote.lines_snapshot.reduce((sum, shipmentLine) => (
        sum + BigInt(shipmentLine.unitPriceMinor) * BigInt(shipmentLine.quantity)
      ), BigInt(0))
      if (merchandiseTotal > BigInt('9223372036854775807')) {
        requestError(
          'OPERATIONS_ONE_OFF_ORDER_VALUE_INVALID',
          'The one-off shipment merchandise value exceeds the supported range',
          409,
        )
      }
      const orderResult = await client.query<{
        id: string
        global_id: string
        row_version: string
      }>(
        `INSERT INTO operations_orders (
           organization_id, pipeline_id, customer_id, integration_account_id,
           contract_version_id, source_provider, external_order_id,
           order_number, order_type, status, currency,
           merchandise_total_minor, requested_delivery_at,
           promised_delivery_at, ship_to, source_payload,
           row_version, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid,
           NULL, 'clawpilot_native', $5, $6, 'one_off', 'imported', $7,
           $8, $9::timestamptz, $10::timestamptz, $11::jsonb,
           $12::jsonb, 0, $13, $13
         )
         RETURNING id::text, global_id, row_version::text`,
        [
          organizationId,
          quote.pipeline_id,
          quote.customer_id,
          nativeIntegration.rows[0].id,
          `one-off:${quote.global_id}`,
          quote.reference_number,
          quote.currency,
          merchandiseTotal.toString(),
          quote.requested_delivery_at,
          selectedOffer.estimated_delivery_at,
          JSON.stringify(quote.destination_snapshot),
          JSON.stringify({
            source: 'clawpilot_native',
            quoteGlobalId: quote.global_id,
            selectedOfferGlobalId: selectedOffer.global_id,
            rateEvidenceGlobalId: selectedOffer.rate_evidence_global_id,
            labelPurchased: false,
            postagePurchased: false,
          }),
          input.actorEmail,
        ],
      )
      const order = orderResult.rows[0]
      await client.query(
        `INSERT INTO operations_external_identifiers (
           organization_id, integration_account_id, entity_type,
           entity_global_id, external_id, status, match_method,
           match_evidence, last_verified_at
         ) VALUES (
           $1::uuid, $2::uuid, 'operations.order', $3, $4,
           'active', 'native_quote', $5::jsonb, now()
         )`,
        [
          organizationId,
          nativeIntegration.rows[0].id,
          order.global_id,
          `one-off:${quote.global_id}`,
          JSON.stringify({ quoteGlobalId: quote.global_id }),
        ],
      )
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.order.imported',
        actorEmail: input.actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${quote.global_id}:one-off-order-imported`,
        payload: {
          sourceProvider: 'clawpilot_native',
          orderType: 'one_off',
          quoteGlobalId: quote.global_id,
          customerId: quote.customer_id,
          lineCount: quote.lines_snapshot.length,
        },
      })
      const orderLines = new Map<string, {
        id: string
        globalId: string
        product: CreatedProduct
        positions: InventoryPosition[]
        quantity: number
      }>()
      for (const shipmentLine of quote.lines_snapshot) {
        const existing = existingProducts.get(shipmentLine.lineKey)
        const created = newProductResult.products.get(shipmentLine.lineKey)
        const product = existing?.product || created
        if (!product) {
          requestError(
            'OPERATIONS_ONE_OFF_PRODUCT_RESOLUTION_FAILED',
            `Product on line ${shipmentLine.lineKey} could not be materialized`,
            409,
          )
        }
        const lineResult = await client.query<{ id: string; global_id: string }>(
          `INSERT INTO operations_order_lines (
             organization_id, order_id, pipeline_id, product_id,
             external_line_id, channel_sku, description, quantity,
             unit_price_minor, weight_grams, dimensions_mm
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5, $6, $7, $8, $9, $10, $11::jsonb
           )
           RETURNING id::text, global_id`,
          [
            organizationId,
            order.id,
            quote.pipeline_id,
            product.id,
            shipmentLine.lineKey,
            product.sku,
            product.name,
            shipmentLine.quantity,
            product.unitPriceMinor,
            product.unitWeightGrams,
            JSON.stringify(product.unitDimensionsMm),
          ],
        )
        let positions = existing?.positions || []
        if (created?.positionId) {
          const newPosition = await client.query<InventoryPosition>(
            `SELECT position.id::text, position.global_id,
                    position.location_id::text,
                    location.global_id AS location_global_id,
                    position.version::text, position.on_hand_quantity::text,
                    position.reserved_quantity::text,
                    position.damaged_quantity::text
             FROM operations_inventory_positions position
             JOIN operations_locations location
               ON location.organization_id = position.organization_id
              AND location.id = position.location_id
             WHERE position.organization_id = $1::uuid
               AND position.id = $2::uuid
             FOR UPDATE OF position`,
            [organizationId, created.positionId],
          )
          positions = newPosition.rows
        }
        orderLines.set(shipmentLine.lineKey, {
          id: lineResult.rows[0].id,
          globalId: lineResult.rows[0].global_id,
          product,
          positions,
          quantity: shipmentLine.quantity,
        })
      }
      const reservations: Array<{
        lineKey: string
        orderLineId: string
        orderLineGlobalId: string
        reservationId: string
        reservationGlobalId: string
        positionId: string
        positionGlobalId: string
        quantity: number
      }> = []
      for (const [lineKey, orderLine] of orderLines) {
        let remaining = orderLine.quantity
        for (const position of orderLine.positions) {
          if (remaining <= 0) break
          const available = numberValue(position.on_hand_quantity)
            - numberValue(position.reserved_quantity)
            - numberValue(position.damaged_quantity)
          const allocated = Math.min(remaining, available)
          if (allocated <= 0) continue
          const reservedAfter = numberValue(position.reserved_quantity) + allocated
          await client.query(
            `UPDATE operations_inventory_positions
             SET reserved_quantity = $3, version = version + 1, updated_at = now()
             WHERE organization_id = $1::uuid AND id = $2::uuid`,
            [organizationId, position.id, reservedAfter],
          )
          const reservation = await client.query<{ id: string; global_id: string }>(
            `INSERT INTO operations_reservations (
               organization_id, order_id, order_line_id, position_id,
               quantity, status, idempotency_key, created_by,
               reservation_authority
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5, 'active', $6, $7, 'local_balance'
             )
             RETURNING id::text, global_id`,
            [
              organizationId,
              order.id,
              orderLine.id,
              position.id,
              allocated,
              `${quote.global_id}:${lineKey}:${position.global_id}:reservation`,
              input.actorEmail,
            ],
          )
          await client.query(
            `INSERT INTO operations_inventory_ledger (
               organization_id, position_id, event_type,
               on_hand_delta, reserved_delta, damaged_delta,
               on_hand_after, reserved_after, damaged_after,
               source_global_id, reason, idempotency_key, actor_email,
               source_authority
             ) VALUES (
               $1::uuid, $2::uuid, 'reservation', 0, $3, 0,
               $4, $5, $6, $7, $8, $9, $10, 'clawpilot'
             )`,
            [
              organizationId,
              position.id,
              allocated,
              numberValue(position.on_hand_quantity),
              reservedAfter,
              numberValue(position.damaged_quantity),
              orderLine.globalId,
              `Reserved for one-off shipment ${quote.global_id}`,
              `${quote.global_id}:${lineKey}:${position.global_id}:reservation-ledger`,
              input.actorEmail,
            ],
          )
          reservations.push({
            lineKey,
            orderLineId: orderLine.id,
            orderLineGlobalId: orderLine.globalId,
            reservationId: reservation.rows[0].id,
            reservationGlobalId: reservation.rows[0].global_id,
            positionId: position.id,
            positionGlobalId: position.global_id,
            quantity: allocated,
          })
          remaining -= allocated
        }
        if (remaining > 0) {
          requestError(
            'OPERATIONS_ONE_OFF_INVENTORY_INSUFFICIENT',
            `${orderLine.product.name} no longer has enough local inventory`,
            409,
          )
        }
      }
      const selectedDeliveryAt = new Date(selectedOffer.estimated_delivery_at)
      const selectedTransitDays = Number.isSafeInteger(selectedOffer.transit_days)
        && Number(selectedOffer.transit_days) >= 0
        ? Number(selectedOffer.transit_days)
        : Math.max(0, Math.ceil(
            (selectedDeliveryAt.getTime() - Date.now()) / DAY_MS,
          ))
      const plan = await client.query<{ id: string; global_id: string }>(
        `INSERT INTO operations_fulfillment_plans (
           organization_id, order_id, warehouse_id, version_number, status,
           method, solver_status, fallback_reason, estimated_cost_minor,
           estimated_revenue_minor, estimated_margin_minor,
           promised_delivery_at, explanation, created_by,
           cartonization_evidence_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 1, 'planned',
           'manual_override', 'one_off_quote', NULL, $4,
           NULL, NULL, $5::timestamptz, $6::jsonb, $7, NULL
         )
         RETURNING id::text, global_id`,
        [
          organizationId,
          order.id,
          quote.warehouse_id,
          selectedOffer.amount_minor,
          selectedOffer.estimated_delivery_at,
          JSON.stringify({
            source: 'one_off_shipment_quote',
            quoteGlobalId: quote.global_id,
            selectedOfferGlobalId: selectedOffer.global_id,
            rateEvidenceGlobalId: selectedOffer.rate_evidence_global_id,
            inventoryAuthority: 'clawpilot',
            planningReason: reason,
            labelPurchaseEnabled: false,
          }),
          input.actorEmail,
        ],
      )
      for (const reservation of reservations) {
        await client.query(
          `INSERT INTO operations_fulfillment_allocations (
             organization_id, plan_id, order_line_id, reservation_id,
             position_id, quantity
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6
           )`,
          [
            organizationId,
            plan.rows[0].id,
            reservation.orderLineId,
            reservation.reservationId,
            reservation.positionId,
            reservation.quantity,
          ],
        )
      }
      await client.query(
        `INSERT INTO operations_carton_plans (
           organization_id, plan_id, algorithm, package_count,
           total_weight_grams, packages
         ) VALUES (
           $1::uuid, $2::uuid, 'operator_explicit_one_off', $3, $4, $5::jsonb
         )`,
        [
          organizationId,
          plan.rows[0].id,
          quote.packages_snapshot.length,
          quote.packages_snapshot.reduce((sum, item) => sum + item.grossWeightGrams, 0),
          JSON.stringify(quote.packages_snapshot),
        ],
      )
      for (const offer of offersResult.rows) {
        if (!offer.estimated_delivery_at) continue
        const deliveryAt = new Date(offer.estimated_delivery_at)
        const transitDays = Number.isSafeInteger(offer.transit_days)
          && Number(offer.transit_days) >= 0
          ? Number(offer.transit_days)
          : Math.max(0, Math.ceil((deliveryAt.getTime() - Date.now()) / DAY_MS))
        await client.query(
          `INSERT INTO operations_carrier_rates (
             organization_id, plan_id, carrier, service_code, service_name,
             internal_cost_minor, customer_charge_minor, transit_days,
             estimated_delivery_at, meets_promise, selected, quote_snapshot
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, NULL, $7,
             $8::timestamptz, $9, $10, $11::jsonb
           )`,
          [
            organizationId,
            plan.rows[0].id,
            oneOffProviderLabel(offer.provider),
            offer.service_code,
            offer.service_name,
            offer.amount_minor,
            transitDays,
            offer.estimated_delivery_at,
            quote.requested_delivery_at
              ? deliveryAt.getTime() <= new Date(quote.requested_delivery_at).getTime()
              : true,
            offer.global_id === selectedOffer.global_id,
            JSON.stringify({
              ...offer.offer_snapshot,
              quoteGlobalId: quote.global_id,
              offerGlobalId: offer.global_id,
              rateEvidenceGlobalId: offer.rate_evidence_global_id,
            }),
          ],
        )
      }
      const packagedQuantity = new Map<string, number>()
      for (const [packageIndex, shipmentPackage] of quote.packages_snapshot.entries()) {
        const packageResult = await client.query<{ id: string; global_id: string }>(
          `INSERT INTO operations_packages (
             organization_id, plan_id, package_number, length_mm, width_mm,
             height_mm, weight_grams, status,
             cartonization_evidence_id, evidence_package_key
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
             'planned', NULL, NULL
           )
           RETURNING id::text, global_id`,
          [
            organizationId,
            plan.rows[0].id,
            packageIndex + 1,
            shipmentPackage.dimensionsMm.length,
            shipmentPackage.dimensionsMm.width,
            shipmentPackage.dimensionsMm.height,
            shipmentPackage.grossWeightGrams,
          ],
        )
        for (const packageAllocation of shipmentPackage.allocations) {
          const orderLine = orderLines.get(packageAllocation.lineKey)
          if (!orderLine) {
            requestError(
              'OPERATIONS_ONE_OFF_QUOTE_SNAPSHOT_INVALID',
              `Parcel ${shipmentPackage.packageKey} references an unknown line`,
              409,
            )
          }
          await client.query(
            `INSERT INTO operations_package_contents (
               organization_id, plan_id, order_id, package_id,
               order_line_id, quantity, created_by
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5::uuid, $6, $7
             )`,
            [
              organizationId,
              plan.rows[0].id,
              order.id,
              packageResult.rows[0].id,
              orderLine.id,
              packageAllocation.quantity,
              input.actorEmail,
            ],
          )
          packagedQuantity.set(
            packageAllocation.lineKey,
            (packagedQuantity.get(packageAllocation.lineKey) || 0)
              + packageAllocation.quantity,
          )
        }
      }
      for (const [lineKey, orderLine] of orderLines) {
        if (packagedQuantity.get(lineKey) !== orderLine.quantity) {
          requestError(
            'OPERATIONS_ONE_OFF_PACKAGE_ALLOCATION_INVALID',
            `Parcel allocations do not cover order line ${lineKey}`,
            409,
          )
        }
      }
      const updatedOrder = await client.query<{ row_version: string }>(
        `UPDATE operations_orders
         SET status = 'planned', promised_delivery_at = $3::timestamptz,
             row_version = row_version + 1, updated_by = $4, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND status = 'imported' AND row_version = 0
         RETURNING row_version::text`,
        [
          organizationId,
          order.id,
          selectedOffer.estimated_delivery_at,
          input.actorEmail,
        ],
      )
      if (!updatedOrder.rows[0]) {
        requestError(
          'OPERATIONS_ONE_OFF_ORDER_STATE_CONFLICT',
          'The native one-off order changed before planning completed',
          409,
        )
      }
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.inventory.reserved',
        actorEmail: input.actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${quote.global_id}:one-off-inventory-reserved`,
        payload: {
          quoteGlobalId: quote.global_id,
          reservations: reservations.map((reservation) => ({
            reservationGlobalId: reservation.reservationGlobalId,
            positionGlobalId: reservation.positionGlobalId,
            orderLineGlobalId: reservation.orderLineGlobalId,
            quantity: reservation.quantity,
          })),
        },
      })
      await appendDomainEvent(client, {
        organizationId,
        aggregateType: 'operations.order',
        aggregateId: order.id,
        aggregateGlobalId: order.global_id,
        eventType: 'operations.fulfillment.planned',
        actorEmail: input.actorEmail,
        correlationId: command.receipt.correlation_id,
        idempotencyKey: `${quote.global_id}:one-off-fulfillment-planned`,
        payload: {
          quoteGlobalId: quote.global_id,
          selectedOfferGlobalId: selectedOffer.global_id,
          rateEvidenceGlobalId: selectedOffer.rate_evidence_global_id,
          fulfillmentPlanGlobalId: plan.rows[0].global_id,
          packageCount: quote.packages_snapshot.length,
          method: 'manual_override',
          planningReason: reason,
          selectedTransitDays,
          labelPurchaseEnabled: false,
        },
      })
      await client.query(
        `INSERT INTO operations_one_off_shipment_quote_consumptions (
           organization_id, quote_id, order_id, offer_id, reason, consumed_by
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)`,
        [
          organizationId,
          quote.id,
          order.id,
          selectedOffer.id,
          reason,
          input.actorEmail,
        ],
      )
      const result: OneOffShipmentCreateResult = {
        orderGlobalId: order.global_id,
        orderStatus: 'planned',
        rowVersion: numberValue(updatedOrder.rows[0].row_version),
        fulfillmentPlanGlobalId: plan.rows[0].global_id,
        quoteGlobalId: quote.global_id,
        selectedOfferGlobalId: selectedOffer.global_id,
        createdProductGlobalIds: [...newProductResult.products.values()]
          .map((product) => product.globalId),
        receiptGlobalId: newProductResult.receiptGlobalId,
        packageCount: quote.packages_snapshot.length,
        replayed: false,
      }
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.one_off_shipment.created_and_planned',
        aggregateType: 'operations.order',
        aggregateId: order.global_id,
        subject: quote.reference_number,
        organizationId,
        eventKey: `operations:one-off:${quote.global_id}:created-and-planned`,
        payload: {
          ...result,
          customerId: quote.customer_id,
          warehouseId: quote.warehouse_id,
          inventoryPoolId: quote.inventory_pool_id,
          rateEvidenceGlobalId: selectedOffer.rate_evidence_global_id,
          carrier: oneOffProviderLabel(selectedOffer.provider),
          serviceCode: selectedOffer.service_code,
          carrierCostMinor: numberValue(selectedOffer.amount_minor),
          planningReason: reason,
          inventoryAuthority: 'clawpilot',
          labelCalls: 0,
          postagePurchases: 0,
          shipmentWrites: 0,
        },
      }, client)
      await client.query(
        `UPDATE operations_command_receipts
         SET status = 'succeeded', result_global_id = $2,
             result_payload = $3::jsonb, error_code = NULL,
             error_message = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1::uuid AND status = 'processing'`,
        [command.receipt.id, order.global_id, JSON.stringify(result)],
      )
      return result
    })
  } catch (error) {
    await failCreateCommand(command.receipt.id, error)
    throw error
  }
}
