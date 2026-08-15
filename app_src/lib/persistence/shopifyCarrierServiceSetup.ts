import type { QueryResultRow } from 'pg'
import { query } from '@/lib/persistence/postgres'
import {
  carrierAccountAddressFingerprint,
} from '@/lib/integrations/carrierCredentialCrypto'
import {
  isSourceManagedCarrierConfiguration,
  managedCarrierDelegationAllows,
} from '@/lib/integrations/carrierManagedDelegation'

type ActivationRow = QueryResultRow & {
  state: 'disabled' | 'shadow' | 'read_only' | 'active' | 'frozen'
  revision: number
  reason: string | null
  updated_at: Date
}

type WarehouseRow = QueryResultRow & {
  global_id: string
  name: string
  status: 'active' | 'inactive'
  address: Record<string, unknown>
}

type MaterialRow = QueryResultRow & {
  global_id: string
  code: string
  name: string
  material_type: 'carton' | 'poly_mailer' | 'padded_mailer'
  row_version: string
  status: 'draft' | 'active'
  rated_outer_length_mm: number | null
  rated_outer_width_mm: number | null
  rated_outer_height_mm: number | null
  rated_outer_dimension_evidence_type: string | null
  rated_outer_dimension_evidence_reference: string | null
  tare_weight_grams: number | null
  max_weight_grams: number | null
  warehouse_global_id: string | null
  stock_available: boolean | null
  stock_on_hand_quantity: number | null
}

type CarrierRow = QueryResultRow & {
  global_id: string
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'mock' | 'sandbox' | 'production'
  display_name: string
  account_number_last_four: string
  account_status: 'needs_configuration' | 'active' | 'disabled'
  integration_status: 'active' | 'disabled' | 'error'
  verification_status: 'unverified' | 'verified' | 'failed'
  allow_sender_billing: boolean
  registered_address_fingerprint: string
  configuration: Record<string, unknown>
}

type EvidenceSummaryRow = QueryResultRow & {
  total_receipts: string
  succeeded_receipts: string
  failed_receipts: string
  processing_receipts: string
  last_received_at: Date | null
  last_succeeded_at: Date | null
}

type ReceiptRow = QueryResultRow & {
  global_id: string
  status: 'processing' | 'succeeded' | 'failed'
  currency: string
  package_count: number | null
  offer_count: number | null
  error_code: string | null
  provider_write_count: number
  received_at: Date
  completed_at: Date | null
}

export type ShopifyCarrierServiceSetupReference = {
  activation: {
    state: ActivationRow['state'] | 'missing'
    revision: number | null
    reason: string | null
    updatedAt: string | null
  }
  warehouses: Array<{
    globalId: string
    name: string
    status: WarehouseRow['status']
  }>
  materials: Array<{
    globalId: string
    code: string
    name: string
    materialType: MaterialRow['material_type']
    rowVersion: number
    status: MaterialRow['status']
    ratedOuterDimensionsMm: {
      length: number | null
      width: number | null
      height: number | null
    }
    ratedOuterDimensionEvidenceType: string | null
    ratedOuterDimensionEvidenceReference: string | null
    tareWeightGrams: number | null
    maxWeightGrams: number | null
    stock: Array<{
      warehouseGlobalId: string
      available: boolean
      onHandQuantity: number | null
    }>
  }>
  carrierAccounts: Array<{
    globalId: string
    provider: CarrierRow['provider']
    environment: CarrierRow['environment']
    displayName: string
    accountNumberLastFour: string
    accountStatus: CarrierRow['account_status']
    integrationStatus: CarrierRow['integration_status']
    verificationStatus: CarrierRow['verification_status']
    allowSenderBilling: boolean
    allowedCapabilities: string[] | null
    matchingWarehouseGlobalIds: string[]
    readinessIssues: string[]
  }>
  evidence: {
    totalReceipts: number
    succeededReceipts: number
    failedReceipts: number
    processingReceipts: number
    lastReceivedAt: string | null
    lastSucceededAt: string | null
    latest: Array<{
      globalId: string
      status: ReceiptRow['status']
      currency: string
      packageCount: number
      offerCount: number
      errorCode: string | null
      providerWriteCount: number
      receivedAt: string
      completedAt: string | null
    }>
  }
}

function iso(value: Date | null) {
  return value ? new Date(value).toISOString() : null
}

function number(value: string | number | null) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function warehouseAddressFingerprint(
  value: unknown,
) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const address = value as Record<string, unknown>
    const countryCode = address.countryCode ?? address.country
    if (typeof countryCode !== 'string' || !countryCode.trim()) return null
    return carrierAccountAddressFingerprint({
      line1: address.line1 ?? address.address1,
      line2: address.line2 ?? address.address2 ?? null,
      city: address.city,
      region: address.regionCode ?? address.region ?? address.state,
      postalCode: address.postalCode ?? address.zip,
      countryCode,
    })
  } catch {
    return null
  }
}

function carrierCapabilityReady(row: CarrierRow) {
  const configuration = row.configuration
    && typeof row.configuration === 'object'
    && !Array.isArray(row.configuration)
    ? row.configuration
    : {}
  const capability = row.environment === 'production'
    ? 'production_rate'
    : 'sandbox_rate'
  if (isSourceManagedCarrierConfiguration(configuration)) {
    return managedCarrierDelegationAllows(configuration, capability)
  }
  const configured = configuration.allowedCapabilities
  return Array.isArray(configured)
    ? configured.includes(capability)
    : row.environment === 'sandbox'
}

function carrierReadinessIssues(row: CarrierRow) {
  return [
    ...(row.environment !== 'sandbox' && row.environment !== 'production'
      ? ['environment_not_supported']
      : []),
    ...(row.account_status !== 'active' ? ['account_not_active'] : []),
    ...(row.integration_status !== 'active'
      ? ['connection_not_active']
      : []),
    ...(row.verification_status !== 'verified'
      ? ['credential_not_verified']
      : []),
    ...(!row.allow_sender_billing ? ['sender_billing_not_allowed'] : []),
    ...(!carrierCapabilityReady(row)
      ? [row.environment === 'production'
          ? 'production_rate_not_authorized'
          : 'sandbox_rate_not_authorized']
      : []),
  ]
}

export async function readShopifyCarrierServiceSetupReferenceFromPostgres(
  input: {
    organizationId: string
    accountGlobalId: string
  },
): Promise<ShopifyCarrierServiceSetupReference> {
  const [
    activationResult,
    warehouseResult,
    materialResult,
    carrierResult,
    evidenceSummaryResult,
    receiptResult,
  ] = await Promise.all([
    query<ActivationRow>(
      `SELECT state, revision, reason, updated_at
       FROM operations_activation_scopes
       WHERE organization_id = $1::uuid`,
      [input.organizationId],
    ),
    query<WarehouseRow>(
      `SELECT global_id, name, status, address
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
       ORDER BY
         CASE status WHEN 'active' THEN 0 ELSE 1 END,
         lower(name),
         global_id`,
      [input.organizationId],
    ),
    query<MaterialRow>(
      `SELECT
         material.global_id,
         material.code,
         material.name,
         material.material_type,
         material.row_version::text,
         material.status,
         material.rated_outer_length_mm,
         material.rated_outer_width_mm,
         material.rated_outer_height_mm,
         material.rated_outer_dimension_evidence_type,
         material.rated_outer_dimension_evidence_reference,
         material.tare_weight_grams,
         material.max_weight_grams,
         warehouse.global_id AS warehouse_global_id,
         stock.is_available AS stock_available,
         stock.on_hand_quantity AS stock_on_hand_quantity
       FROM operations_packaging_materials material
       LEFT JOIN operations_packaging_material_stock stock
         ON stock.organization_id = material.organization_id
        AND stock.packaging_material_id = material.id
       LEFT JOIN operations_warehouses warehouse
         ON warehouse.organization_id = stock.organization_id
        AND warehouse.id = stock.warehouse_id
       WHERE material.organization_id = $1::uuid
       ORDER BY
         CASE material.status WHEN 'active' THEN 0 ELSE 1 END,
         lower(material.name),
         material.global_id,
         lower(warehouse.name),
         warehouse.global_id`,
      [input.organizationId],
    ),
    query<CarrierRow>(
      `SELECT
         carrier.global_id,
         integration.provider,
         integration.environment,
         carrier.display_name,
         carrier.account_number_last_four,
         carrier.status AS account_status,
         integration.status AS integration_status,
         credential.verification_status,
         carrier.allow_sender_billing,
         carrier.registered_address_fingerprint,
         integration.configuration
       FROM operations_carrier_accounts carrier
       JOIN operations_integration_accounts integration
         ON integration.organization_id = carrier.organization_id
        AND integration.id = carrier.integration_account_id
       LEFT JOIN operations_carrier_credentials credential
         ON credential.organization_id = integration.organization_id
        AND credential.integration_account_id = integration.id
       WHERE carrier.organization_id = $1::uuid
         AND integration.integration_type = 'carrier'
         AND integration.provider IN ('ups_rest', 'fedex_rest')
       ORDER BY
         integration.environment,
         integration.provider,
         lower(carrier.display_name),
         carrier.global_id`,
      [input.organizationId],
    ),
    query<EvidenceSummaryRow>(
      `SELECT
         count(receipt.id)::text AS total_receipts,
         count(receipt.id) FILTER (
           WHERE receipt.status = 'succeeded'
         )::text AS succeeded_receipts,
         count(receipt.id) FILTER (
           WHERE receipt.status = 'failed'
         )::text AS failed_receipts,
         count(receipt.id) FILTER (
           WHERE receipt.status = 'processing'
         )::text AS processing_receipts,
         max(receipt.created_at) AS last_received_at,
         max(receipt.completed_at) FILTER (
           WHERE receipt.status = 'succeeded'
         ) AS last_succeeded_at
       FROM operations_integration_accounts account
       LEFT JOIN operations_shopify_checkout_rate_receipts receipt
         ON receipt.organization_id = account.organization_id
        AND receipt.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.provider = 'shopify'
         AND account.integration_type = 'commerce'`,
      [input.organizationId, input.accountGlobalId],
    ),
    query<ReceiptRow>(
      `SELECT
         receipt.global_id,
         receipt.status,
         receipt.currency,
         receipt.package_count,
         receipt.offer_count,
         receipt.error_code,
         receipt.provider_write_count,
         receipt.created_at AS received_at,
         receipt.completed_at
       FROM operations_shopify_checkout_rate_receipts receipt
       JOIN operations_integration_accounts account
         ON account.organization_id = receipt.organization_id
        AND account.id = receipt.integration_account_id
       WHERE receipt.organization_id = $1::uuid
         AND account.global_id = $2
       ORDER BY receipt.created_at DESC, receipt.id DESC
       LIMIT 10`,
      [input.organizationId, input.accountGlobalId],
    ),
  ])

  const grouped = new Map<
    string,
    ShopifyCarrierServiceSetupReference['materials'][number]
  >()
  for (const row of materialResult.rows) {
    let material = grouped.get(row.global_id)
    if (!material) {
      material = {
        globalId: row.global_id,
        code: row.code,
        name: row.name,
        materialType: row.material_type,
        rowVersion: number(row.row_version),
        status: row.status,
        ratedOuterDimensionsMm: {
          length: row.rated_outer_length_mm,
          width: row.rated_outer_width_mm,
          height: row.rated_outer_height_mm,
        },
        ratedOuterDimensionEvidenceType:
          row.rated_outer_dimension_evidence_type,
        ratedOuterDimensionEvidenceReference:
          row.rated_outer_dimension_evidence_reference,
        tareWeightGrams: row.tare_weight_grams,
        maxWeightGrams: row.max_weight_grams,
        stock: [],
      }
      grouped.set(row.global_id, material)
    }
    if (row.warehouse_global_id) {
      material.stock.push({
        warehouseGlobalId: row.warehouse_global_id,
        available: row.stock_available === true,
        onHandQuantity: row.stock_on_hand_quantity,
      })
    }
  }

  const activation = activationResult.rows[0]
  const summary = evidenceSummaryResult.rows[0]
  const warehouseFingerprintByGlobalId = new Map(
    warehouseResult.rows.flatMap((warehouse) => {
      const fingerprint = warehouseAddressFingerprint(warehouse.address)
      return fingerprint ? [[warehouse.global_id, fingerprint] as const] : []
    }),
  )
  return {
    activation: activation
      ? {
          state: activation.state,
          revision: activation.revision,
          reason: activation.reason,
          updatedAt: iso(activation.updated_at),
        }
      : {
          state: 'missing',
          revision: null,
          reason: null,
          updatedAt: null,
        },
    warehouses: warehouseResult.rows.map((row) => ({
      globalId: row.global_id,
      name: row.name,
      status: row.status,
    })),
    materials: [...grouped.values()],
    carrierAccounts: carrierResult.rows.map((row) => ({
      globalId: row.global_id,
      provider: row.provider,
      environment: row.environment,
      displayName: row.display_name,
      accountNumberLastFour: row.account_number_last_four,
      accountStatus: row.account_status,
      integrationStatus: row.integration_status,
      verificationStatus: row.verification_status,
      allowSenderBilling: row.allow_sender_billing === true,
      allowedCapabilities: Array.isArray(
        row.configuration?.allowedCapabilities,
      )
        ? row.configuration.allowedCapabilities.filter(
            (value): value is string => typeof value === 'string',
          )
        : null,
      matchingWarehouseGlobalIds: [...warehouseFingerprintByGlobalId]
        .filter(([, fingerprint]) => (
          fingerprint === row.registered_address_fingerprint
        ))
        .map(([globalId]) => globalId),
      readinessIssues: carrierReadinessIssues(row),
    })),
    evidence: {
      totalReceipts: number(summary?.total_receipts || 0),
      succeededReceipts: number(summary?.succeeded_receipts || 0),
      failedReceipts: number(summary?.failed_receipts || 0),
      processingReceipts: number(summary?.processing_receipts || 0),
      lastReceivedAt: iso(summary?.last_received_at || null),
      lastSucceededAt: iso(summary?.last_succeeded_at || null),
      latest: receiptResult.rows.map((row) => ({
        globalId: row.global_id,
        status: row.status,
        currency: row.currency,
        packageCount: number(row.package_count),
        offerCount: number(row.offer_count),
        errorCode: row.error_code,
        providerWriteCount: row.provider_write_count,
        receivedAt: iso(row.received_at) as string,
        completedAt: iso(row.completed_at),
      })),
    },
  }
}
