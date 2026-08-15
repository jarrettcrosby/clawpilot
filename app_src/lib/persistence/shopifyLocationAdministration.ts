import { createHash } from 'node:crypto'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/u
const MAPPING_GLOBAL_ID = /^gilm(?:[0-9]{7}|[0-9a-v]{12})$/u
const AUTHORIZATION_GLOBAL_ID = /^gsla(?:[0-9]{7}|[0-9a-v]{12})$/u
const ATTEMPT_GLOBAL_ID = /^gslt(?:[0-9]{7}|[0-9a-v]{12})$/u
const LOCATION_ID = /^gid:\/\/shopify\/Location\/[1-9][0-9]{0,20}$/u
const SHOP_ID = /^gid:\/\/shopify\/Shop\/[1-9][0-9]{0,20}$/u
const SHOP_DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u
const SHA256 = /^[a-f0-9]{64}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u
const EMAIL = /^[^\s@]+@[^\s@]+$/u

export const SHOPIFY_LOCATION_ADMINISTRATION_CONFIRMATION_VERSION =
  'shopify-location-administration-v1' as const

export type ShopifyLocationAdministrationAction =
  | 'locationAdd'
  | 'locationEdit'
  | 'locationActivate'

export type ShopifyLocationAdministrationDesiredLocation = Readonly<{
  name: string
  address: Readonly<{
    address1: string
    address2: string
    city: string
    provinceCode: string
    countryCode: string
    zip: string
  }>
  fulfillsOnlineOrders: true
}>

type ProviderLocation = Readonly<{
  id: string
  name: string
  isActive: boolean
  activatable: boolean
  shipsInventory: boolean
  fulfillsOnlineOrders: boolean
  isFulfillmentService: boolean
  fulfillmentService: Readonly<{
    id: string
    handle: string
    serviceName: string
  }> | null
  address: ShopifyLocationAdministrationDesiredLocation['address']
}>

export type ShopifyLocationAdministrationWarehouse = Readonly<{
  id: string
  globalId: string
  code: string
  name: string
  rowVersion: number
  addressHash: string
  desiredLocation: ShopifyLocationAdministrationDesiredLocation | null
  locationAdministrationReady: boolean
  readinessBlockerCode: string | null
  hasActiveCommerceLocationRouting: boolean
}>

export type ShopifyLocationAdministrationMapping = Readonly<{
  id: string
  globalId: string
  rowVersion: number
  providerLocationId: string
  providerLocationName: string
  warehouseGlobalId: string
  active: boolean
  ownershipClassification:
    | 'unknown'
    | 'merchant_managed'
    | 'fulfillment_service'
  providerSnapshotHash: string | null
  providerSnapshot: Record<string, unknown>
  providerObservedAt: string | null
}>

export type ShopifyLocationAdministrationConfiguration = Readonly<{
  organizationId: string
  accountId: string
  accountGlobalId: string
  accountDisplayName: string
  externalAccountId: string
  shopDomain: string
  credentialGeneration: number
  activationState: 'shadow' | 'active'
  activationRevision: number
  warehouses: readonly ShopifyLocationAdministrationWarehouse[]
  mappings: readonly ShopifyLocationAdministrationMapping[]
}>

export type ShopifyLocationAdministrationAuthorizationStatus =
  | 'prepared'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'reconciled'

export type ShopifyLocationAdministrationAuthorization = Readonly<{
  authorizationId: string
  authorizationGlobalId: string
  organizationId: string
  accountId: string
  accountGlobalId: string
  externalAccountId: string
  shopDomain: string
  credentialGeneration: number
  activationState: 'shadow' | 'active'
  activationRevision: number
  action: ShopifyLocationAdministrationAction
  warehouseId: string
  warehouseGlobalId: string
  warehouseRowVersion: number
  warehouseAddressHash: string
  mappingId: string | null
  mappingGlobalId: string | null
  mappingRowVersion: number | null
  providerLocationId: string | null
  providerSnapshot: Record<string, unknown>
  providerSnapshotHash: string | null
  providerLocationSetHash: string | null
  providerObservedAt: string
  desiredLocation: ShopifyLocationAdministrationDesiredLocation
  desiredLocationHash: string
  authorizationReason: string
  confirmationHash: string
  idempotencyKey: string
  requestHash: string
  providerIdempotencyKey: string
  status: ShopifyLocationAdministrationAuthorizationStatus
  authorizedBy: string
  authorizedRole: 'owner' | 'admin'
  preparedAt: string
  expiresAt: string
  processingAt: string | null
  completedAt: string | null
  attemptId: string | null
  attemptGlobalId: string | null
  latestOutcomeGlobalId: string | null
  outcomeProviderLocationId: string | null
  outcomeProviderWriteCount: 0 | 1 | null
  outcomeErrorCode: string | null
}>

export type ClaimedShopifyLocationAdministration =
  ShopifyLocationAdministrationAuthorization & Readonly<{
    status: 'processing'
    attemptId: string
    attemptGlobalId: string
    processingAt: string
  }>

export class ShopifyLocationAdministrationPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'ShopifyLocationAdministrationPersistenceError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyLocationAdministrationPersistenceError(
    code,
    message,
    status,
  )
}

function identifier(
  value: unknown,
  pattern: RegExp,
  label: string,
  status = 400,
) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!pattern.test(normalized)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_IDENTIFIER_INVALID',
      `${label} is invalid`,
      status,
    )
  }
  return normalized
}

function exactAction(value: unknown): ShopifyLocationAdministrationAction {
  if (
    value === 'locationAdd'
    || value === 'locationEdit'
    || value === 'locationActivate'
  ) return value
  fail(
    'SHOPIFY_LOCATION_ADMINISTRATION_ACTION_INVALID',
    'Supported Shopify location actions are add, edit, and activate',
    400,
  )
}

function exactActor(value: unknown) {
  const actor = String(value || '').trim().toLowerCase()
  if (
    actor.length < 3
    || actor.length > 320
    || !EMAIL.test(actor)
    || /[\u0000-\u001f\u007f]/u.test(actor)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_ACTOR_REQUIRED',
      'A signed-in owner or administrator is required',
      401,
    )
  }
  return actor
}

function exactRole(value: unknown): 'owner' | 'admin' {
  if (value === 'owner' || value === 'admin') return value
  fail(
    'SHOPIFY_LOCATION_ADMINISTRATION_ROLE_REQUIRED',
    'An owner or administrator role is required',
    403,
  )
}

function exactInteger(value: unknown, label: string) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function exactIdempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_IDEMPOTENCY_REQUIRED',
      'A stable Idempotency-Key of 8-200 characters is required',
      400,
    )
  }
  return normalized
}

function exactReason(value: unknown) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < 10
    || normalized.length > 500
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_REASON_REQUIRED',
      'An operator reason of 10-500 characters is required',
      400,
    )
  }
  return normalized
}

function exactConfirmation(value: unknown) {
  const normalized = String(value || '')
  if (
    normalized.length < 20
    || normalized.length > 500
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_CONFIRMATION_REQUIRED',
      'The exact typed confirmation is required',
      400,
    )
  }
  return normalized
}

function iso(value: string | Date | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_INVALID',
        'Location administration evidence is invalid',
        400,
      )
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_INVALID',
      'Location administration evidence is invalid',
      400,
    )
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`
    }
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key], ancestors)}`
    )).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function hash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function safeProviderLocation(value: unknown): ProviderLocation {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const address = source?.address
    && typeof source.address === 'object'
    && !Array.isArray(source.address)
    ? source.address as Record<string, unknown>
    : null
  const id = String(source?.id || '').trim()
  const countryCode = String(address?.countryCode || '').trim().toUpperCase()
  const name = String(source?.name || '').trim()
  if (
    !source
    || !address
    || !LOCATION_ID.test(id)
    || !name
    || name.length > 255
    || !/^[A-Z]{2}$/u.test(countryCode)
    || typeof source.isActive !== 'boolean'
    || typeof source.activatable !== 'boolean'
    || typeof source.shipsInventory !== 'boolean'
    || typeof source.fulfillsOnlineOrders !== 'boolean'
    || typeof source.isFulfillmentService !== 'boolean'
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_PROVIDER_SNAPSHOT_INVALID',
      'The exact Shopify location snapshot is invalid',
      400,
    )
  }
  const fulfillmentService = source.fulfillmentService === null
    ? null
    : source.fulfillmentService
      && typeof source.fulfillmentService === 'object'
      && !Array.isArray(source.fulfillmentService)
      ? source.fulfillmentService as Record<string, unknown>
      : undefined
  if (
    source.isFulfillmentService !== Boolean(fulfillmentService)
    || (fulfillmentService && (
      !String(fulfillmentService.id || '').trim()
      || !String(fulfillmentService.handle || '').trim()
      || !String(fulfillmentService.serviceName || '').trim()
    ))
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_PROVIDER_SNAPSHOT_INVALID',
      'Shopify location ownership evidence is invalid',
      400,
    )
  }
  const location = {
    id,
    name,
    isActive: source.isActive,
    activatable: source.activatable,
    shipsInventory: source.shipsInventory,
    fulfillsOnlineOrders: source.fulfillsOnlineOrders,
    isFulfillmentService: source.isFulfillmentService,
    fulfillmentService: fulfillmentService
      ? {
          id: String(fulfillmentService.id),
          handle: String(fulfillmentService.handle),
          serviceName: String(fulfillmentService.serviceName),
        }
      : null,
    address: {
      address1: String(address.address1 || ''),
      address2: String(address.address2 || ''),
      city: String(address.city || ''),
      provinceCode: String(address.provinceCode || '').toUpperCase(),
      countryCode,
      zip: String(address.zip || ''),
    },
  } satisfies ProviderLocation
  if (location.isFulfillmentService) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_FULFILLMENT_SERVICE_FORBIDDEN',
      'Fulfillment-service locations are read-only and cannot be claimed, edited, or activated by ClawPilot',
      409,
    )
  }
  return Object.freeze(location)
}

function desiredFromWarehouse(
  nameValue: unknown,
  addressValue: unknown,
): ShopifyLocationAdministrationDesiredLocation | null {
  const name = String(nameValue || '').trim()
  const address = addressValue && typeof addressValue === 'object'
    && !Array.isArray(addressValue)
    ? addressValue as Record<string, unknown>
    : {}
  const countryCode = String(
    address.countryCode || address.country || '',
  ).trim().toUpperCase()
  const address1 = String(address.address1 || address.line1 || '').trim()
  const city = String(address.city || '').trim()
  const provinceCode = String(
    address.provinceCode || address.regionCode || address.region || '',
  ).trim().toUpperCase()
  const zip = String(address.zip || address.postalCode || '').trim()
  if (
    !name
    || name.length > 255
    || !address1
    || address1.length > 255
    || !city
    || city.length > 255
    || !provinceCode
    || provinceCode.length > 64
    || !zip
    || zip.length > 64
    || !/^[A-Z]{2}$/u.test(countryCode)
  ) return null
  return Object.freeze({
    name,
    address: Object.freeze({
      address1,
      address2: String(address.address2 || address.line2 || '').trim(),
      city,
      provinceCode,
      countryCode,
      zip,
    }),
    fulfillsOnlineOrders: true as const,
  })
}

function providerMatchesDesired(
  location: ProviderLocation,
  desired: ShopifyLocationAdministrationDesiredLocation,
) {
  return !location.isFulfillmentService
    && location.name === desired.name
    && location.fulfillsOnlineOrders
    && canonicalJson(location.address) === canonicalJson(desired.address)
}

type ConfigurationAccountRow = QueryResultRow & {
  account_id: string
  account_global_id: string
  account_display_name: string
  external_account_id: string
  shop_domain: string
  credential_generation: number
  activation_state: 'shadow' | 'active'
  activation_revision: number
}

type WarehouseRow = QueryResultRow & {
  id: string
  global_id: string
  code: string
  name: string
  row_version: string
  address: Record<string, unknown>
  address_hash: string
  has_active_commerce_location_routing: boolean
}

type MappingRow = QueryResultRow & {
  id: string
  global_id: string
  row_version: string
  external_location_id: string
  external_location_name: string
  warehouse_global_id: string
  active: boolean
  ownership_classification: ShopifyLocationAdministrationMapping['ownershipClassification']
  provider_snapshot_hash: string | null
  provider_snapshot_json: Record<string, unknown>
  provider_observed_at: string | Date | null
}

type QueryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>
}

function configurationFromRows(
  organizationId: string,
  account: ConfigurationAccountRow,
  warehouseRows: readonly WarehouseRow[],
  mappingRows: readonly MappingRow[],
): ShopifyLocationAdministrationConfiguration {
  return Object.freeze({
    organizationId,
    accountId: account.account_id,
    accountGlobalId: account.account_global_id,
    accountDisplayName: account.account_display_name,
    externalAccountId: account.external_account_id,
    shopDomain: account.shop_domain,
    credentialGeneration: Number(account.credential_generation),
    activationState: account.activation_state,
    activationRevision: Number(account.activation_revision),
    warehouses: Object.freeze(warehouseRows.map((row) => {
      const desiredLocation = desiredFromWarehouse(row.name, row.address)
      return Object.freeze({
        id: row.id,
        globalId: row.global_id,
        code: row.code,
        name: row.name,
        rowVersion: Number(row.row_version),
        addressHash: row.address_hash,
        desiredLocation,
        locationAdministrationReady: Boolean(desiredLocation),
        readinessBlockerCode: desiredLocation
          ? null
          : 'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_ADDRESS_INCOMPLETE',
        hasActiveCommerceLocationRouting:
          row.has_active_commerce_location_routing,
      })
    })),
    mappings: Object.freeze(mappingRows.map((row) => Object.freeze({
      id: row.id,
      globalId: row.global_id,
      rowVersion: Number(row.row_version),
      providerLocationId: row.external_location_id,
      providerLocationName: row.external_location_name,
      warehouseGlobalId: row.warehouse_global_id,
      active: row.active,
      ownershipClassification: row.ownership_classification,
      providerSnapshotHash: row.provider_snapshot_hash,
      providerSnapshot: row.provider_snapshot_json,
      providerObservedAt: iso(row.provider_observed_at),
    }))),
  })
}

async function readConfigurationWithClient(
  client: QueryClient,
  input: { organizationId: string; accountGlobalId: string },
) {
  const accountResult = await client.query<ConfigurationAccountRow>(
    `SELECT account.id::text AS account_id,
            account.global_id AS account_global_id,
            account.display_name AS account_display_name,
            account.external_account_id,
            lower(account.configuration->>'shopDomain') AS shop_domain,
            account.commerce_credential_generation AS credential_generation,
            activation.state AS activation_state,
            activation.revision AS activation_revision
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
      WHERE account.organization_id = $1::uuid
        AND account.global_id = $2
        AND account.integration_type = 'commerce'
        AND account.provider = 'shopify'
        AND account.environment = 'sandbox'
        AND account.status = 'active'
        AND account.external_account_id ~
              '^gid://shopify/Shop/[1-9][0-9]{0,20}$'
        AND lower(account.configuration->>'shopDomain') ~
              '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.myshopify\\.com$'
        AND credential.external_account_id = account.external_account_id
        AND credential.auth_mode = 'shopify_client_credentials'
        AND credential.credential_version =
              account.commerce_credential_generation
        AND credential.verification_status = 'verified'
        AND activation.state IN ('shadow', 'active')
      LIMIT 1`,
    [input.organizationId, input.accountGlobalId],
  )
  const account = accountResult.rows[0]
  if (!account) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_CONFIGURATION_UNAVAILABLE',
      'An active verified Shopify sandbox connection is required',
      404,
    )
  }
  if (
    !SHOP_ID.test(account.external_account_id)
    || !SHOP_DOMAIN.test(account.shop_domain)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_CONFIGURATION_INVALID',
      'The Shopify sandbox identity is invalid',
      500,
    )
  }
  const [warehouses, mappings] = await Promise.all([
    client.query<WarehouseRow>(
      `SELECT warehouse.id::text, warehouse.global_id, warehouse.code,
              warehouse.name, warehouse.row_version::text,
              warehouse.address,
              encode(
                digest(convert_to(warehouse.address::text, 'UTF8'), 'sha256'),
                'hex'
              ) AS address_hash,
              EXISTS (
                SELECT 1
                  FROM operations_commerce_inventory_location_mappings routing
                 WHERE routing.organization_id = warehouse.organization_id
                   AND routing.warehouse_id = warehouse.id
                   AND routing.active
              ) AS has_active_commerce_location_routing
         FROM operations_warehouses warehouse
        WHERE warehouse.organization_id = $1::uuid
          AND warehouse.status = 'active'
        ORDER BY lower(warehouse.name), warehouse.global_id`,
      [input.organizationId],
    ),
    client.query<MappingRow>(
      `SELECT mapping.id::text, mapping.global_id,
              mapping.row_version::text, mapping.external_location_id,
              mapping.external_location_name, warehouse.global_id AS warehouse_global_id,
              mapping.active, mapping.ownership_classification,
              mapping.provider_snapshot_hash,
              mapping.provider_snapshot_json,
              mapping.provider_observed_at
         FROM operations_commerce_inventory_location_mappings mapping
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = mapping.organization_id
          AND warehouse.id = mapping.warehouse_id
        WHERE mapping.organization_id = $1::uuid
          AND mapping.integration_account_id = $2::uuid
        ORDER BY mapping.global_id`,
      [input.organizationId, account.account_id],
    ),
  ])
  return configurationFromRows(
    input.organizationId,
    account,
    warehouses.rows,
    mappings.rows,
  )
}

export async function readShopifyLocationAdministrationConfigurationInPostgres(
  input: { organizationId: unknown; accountGlobalId: unknown },
) {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const accountGlobalId = identifier(
    input.accountGlobalId,
    ACCOUNT_GLOBAL_ID,
    'Shopify account Global ID',
  )
  const client = { query }
  return readConfigurationWithClient(client, {
    organizationId,
    accountGlobalId,
  })
}

type AuthorizationRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  integration_account_global_id: string
  external_account_id: string
  shop_domain: string
  credential_generation: number
  activation_state: 'shadow' | 'active'
  activation_revision: number
  action: ShopifyLocationAdministrationAction
  warehouse_id: string
  warehouse_global_id: string
  warehouse_row_version: string
  warehouse_address_hash: string
  location_mapping_id: string | null
  location_mapping_global_id: string | null
  location_mapping_row_version: string | null
  provider_location_id: string | null
  provider_snapshot_json: Record<string, unknown>
  provider_snapshot_hash: string | null
  provider_location_set_hash: string | null
  provider_observed_at: string | Date
  desired_location_json: ShopifyLocationAdministrationDesiredLocation
  desired_location_hash: string
  authorization_reason: string
  confirmation_hash: string
  idempotency_key: string
  request_hash: string
  provider_idempotency_key: string
  status: ShopifyLocationAdministrationAuthorizationStatus
  authorized_by: string
  authorized_role: 'owner' | 'admin'
  prepared_at: string | Date
  expires_at: string | Date
  processing_at: string | Date | null
  completed_at: string | Date | null
  provider_attempt_id: string | null
  attempt_global_id: string | null
  latest_outcome_global_id: string | null
  outcome_provider_location_id: string | null
  outcome_provider_write_count: number | null
  outcome_error_code: string | null
}

const AUTHORIZATION_SELECT = `SELECT
  authz.id::text,
  authz.global_id,
  authz.organization_id::text,
  authz.integration_account_id::text,
  authz.integration_account_global_id,
  authz.external_account_id,
  authz.shop_domain,
  authz.credential_generation,
  authz.activation_state,
  authz.activation_revision,
  authz.action,
  authz.warehouse_id::text,
  authz.warehouse_global_id,
  authz.warehouse_row_version::text,
  authz.warehouse_address_hash,
  authz.location_mapping_id::text,
  authz.location_mapping_global_id,
  authz.location_mapping_row_version::text,
  authz.provider_location_id,
  authz.provider_snapshot_json,
  authz.provider_snapshot_hash,
  authz.provider_location_set_hash,
  authz.provider_observed_at,
  authz.desired_location_json,
  authz.desired_location_hash,
  authz.authorization_reason,
  authz.confirmation_hash,
  authz.idempotency_key,
  authz.request_hash,
  authz.provider_idempotency_key::text,
  authz.status,
  authz.authorized_by,
  authz.authorized_role,
  authz.prepared_at,
  authz.expires_at,
  authz.processing_at,
  authz.completed_at,
  authz.provider_attempt_id::text,
  attempt.global_id AS attempt_global_id,
  outcome.global_id AS latest_outcome_global_id,
  outcome.provider_location_id AS outcome_provider_location_id,
  outcome.provider_write_count AS outcome_provider_write_count,
  outcome.error_code AS outcome_error_code
FROM operations_shopify_location_administration_authorizations authz
LEFT JOIN operations_shopify_location_administration_attempts attempt
  ON attempt.organization_id = authz.organization_id
 AND attempt.id = authz.provider_attempt_id
LEFT JOIN operations_shopify_location_administration_outcomes outcome
  ON outcome.organization_id = authz.organization_id
 AND outcome.id = authz.latest_outcome_id`

function authorization(row: AuthorizationRow): ShopifyLocationAdministrationAuthorization {
  const desired = desiredFromWarehouse(
    row.desired_location_json?.name,
    row.desired_location_json?.address,
  )
  if (
    !desired
    || hash({ schema: 'shopify-location-desired-v1', location: desired })
      !== row.desired_location_hash
    || !SHA256.test(row.request_hash)
    || !SHA256.test(row.confirmation_hash)
    || !UUID.test(row.provider_idempotency_key)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_INVALID',
      'Durable Shopify location authorization evidence is invalid',
      500,
    )
  }
  return Object.freeze({
    authorizationId: row.id,
    authorizationGlobalId: row.global_id,
    organizationId: row.organization_id,
    accountId: row.integration_account_id,
    accountGlobalId: row.integration_account_global_id,
    externalAccountId: row.external_account_id,
    shopDomain: row.shop_domain,
    credentialGeneration: Number(row.credential_generation),
    activationState: row.activation_state,
    activationRevision: Number(row.activation_revision),
    action: row.action,
    warehouseId: row.warehouse_id,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseRowVersion: Number(row.warehouse_row_version),
    warehouseAddressHash: row.warehouse_address_hash,
    mappingId: row.location_mapping_id,
    mappingGlobalId: row.location_mapping_global_id,
    mappingRowVersion: row.location_mapping_row_version === null
      ? null
      : Number(row.location_mapping_row_version),
    providerLocationId: row.provider_location_id,
    providerSnapshot: row.provider_snapshot_json,
    providerSnapshotHash: row.provider_snapshot_hash,
    providerLocationSetHash: row.provider_location_set_hash,
    providerObservedAt: iso(row.provider_observed_at)!,
    desiredLocation: desired,
    desiredLocationHash: row.desired_location_hash,
    authorizationReason: row.authorization_reason,
    confirmationHash: row.confirmation_hash,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    providerIdempotencyKey: row.provider_idempotency_key,
    status: row.status,
    authorizedBy: row.authorized_by,
    authorizedRole: row.authorized_role,
    preparedAt: iso(row.prepared_at)!,
    expiresAt: iso(row.expires_at)!,
    processingAt: iso(row.processing_at),
    completedAt: iso(row.completed_at),
    attemptId: row.provider_attempt_id,
    attemptGlobalId: row.attempt_global_id,
    latestOutcomeGlobalId: row.latest_outcome_global_id,
    outcomeProviderLocationId: row.outcome_provider_location_id,
    outcomeProviderWriteCount: row.outcome_provider_write_count === null
      ? null
      : Number(row.outcome_provider_write_count) as 0 | 1,
    outcomeErrorCode: row.outcome_error_code,
  })
}

async function readAuthorizationWithClient(
  client: QueryClient,
  input: {
    organizationId: string
    authorizationGlobalId?: string
    attemptGlobalId?: string
    forUpdate?: boolean
  },
) {
  const predicate = input.authorizationGlobalId
    ? 'authz.global_id = $2'
    : 'attempt.global_id = $2'
  const result = await client.query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
      WHERE authz.organization_id = $1::uuid
        AND ${predicate}
      ${input.forUpdate ? 'FOR UPDATE OF authz' : ''}`,
    [
      input.organizationId,
      input.authorizationGlobalId || input.attemptGlobalId,
    ],
  )
  return result.rows[0] ? authorization(result.rows[0]) : null
}

export async function readShopifyLocationAdministrationAuthorizationInPostgres(
  input: {
    organizationId: unknown
    authorizationGlobalId?: unknown
    attemptGlobalId?: unknown
  },
) {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const exactlyOne = Number(Boolean(input.authorizationGlobalId))
    + Number(Boolean(input.attemptGlobalId))
  if (exactlyOne !== 1) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_IDENTIFIER_INVALID',
      'Exactly one authorization or attempt Global ID is required',
      400,
    )
  }
  const authorizationGlobalId = input.authorizationGlobalId
    ? identifier(
        input.authorizationGlobalId,
        AUTHORIZATION_GLOBAL_ID,
        'Shopify location authorization',
      )
    : undefined
  const attemptGlobalId = input.attemptGlobalId
    ? identifier(
        input.attemptGlobalId,
        ATTEMPT_GLOBAL_ID,
        'Shopify location attempt',
      )
    : undefined
  const found = await readAuthorizationWithClient(
    { query },
    { organizationId, authorizationGlobalId, attemptGlobalId },
  )
  if (!found) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_FOUND',
      'Shopify location authorization was not found',
      404,
    )
  }
  return found
}

export async function readPendingShopifyLocationAdministrationsInPostgres(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
    actorEmail: unknown
  },
) {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const accountGlobalId = identifier(
    input.accountGlobalId,
    ACCOUNT_GLOBAL_ID,
    'Shopify account Global ID',
  )
  const actorEmail = exactActor(input.actorEmail)
  const result = await query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
      WHERE authz.organization_id = $1::uuid
        AND authz.integration_account_global_id = $2
        AND authz.authorized_by = $3
        AND (
          authz.status IN ('processing', 'unknown')
          OR (
            authz.status = 'prepared'
            AND authz.expires_at > clock_timestamp()
            AND operations_shopify_location_admin_is_current(
              authz.organization_id, authz.id
            )
          )
        )
      ORDER BY authz.prepared_at DESC, authz.id DESC
      LIMIT 20`,
    [organizationId, accountGlobalId, actorEmail],
  )
  return Object.freeze(result.rows.map(authorization))
}

type PreparationFactsRow = QueryResultRow & {
  integration_account_id: string
  integration_account_global_id: string
  external_account_id: string
  shop_domain: string
  credential_generation: number
  activation_state: 'shadow' | 'active'
  activation_revision: number
  authorized_role: 'owner' | 'admin'
  warehouse_id: string
  warehouse_global_id: string
  warehouse_row_version: string
  warehouse_name: string
  warehouse_address: Record<string, unknown>
  warehouse_address_hash: string
}

async function preparationFacts(
  client: PoolClient,
  input: {
    organizationId: string
    accountGlobalId: string
    actorEmail: string
    actorRole: 'owner' | 'admin'
    warehouseGlobalId: string
    expectedWarehouseRowVersion: number
  },
) {
  const result = await client.query<PreparationFactsRow>(
    `SELECT account.id::text AS integration_account_id,
            account.global_id AS integration_account_global_id,
            account.external_account_id,
            lower(account.configuration->>'shopDomain') AS shop_domain,
            account.commerce_credential_generation AS credential_generation,
            activation.state AS activation_state,
            activation.revision AS activation_revision,
            membership.role AS authorized_role,
            warehouse.id::text AS warehouse_id,
            warehouse.global_id AS warehouse_global_id,
            warehouse.row_version::text AS warehouse_row_version,
            warehouse.name AS warehouse_name,
            warehouse.address AS warehouse_address,
            encode(
              digest(convert_to(warehouse.address::text, 'UTF8'), 'sha256'),
              'hex'
            ) AS warehouse_address_hash
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       JOIN app_user_organization_memberships membership
         ON membership.organization_id = account.organization_id
        AND membership.user_email = $3
        AND membership.status = 'active'
        AND membership.role = $4
        AND membership.role IN ('owner', 'admin')
        AND (
          membership.role = 'owner'
          OR (
            COALESCE(
              (membership.permissions->>'manageOperations')::boolean,
              false
            )
            AND COALESCE(
              (membership.permissions->>'executeWarehouse')::boolean,
              false
            )
          )
        )
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = account.organization_id
        AND warehouse.global_id = $5
        AND warehouse.status = 'active'
        AND warehouse.row_version = $6::bigint
      WHERE account.organization_id = $1::uuid
        AND account.global_id = $2
        AND account.integration_type = 'commerce'
        AND account.provider = 'shopify'
        AND account.environment = 'sandbox'
        AND account.status = 'active'
        AND account.external_account_id ~
              '^gid://shopify/Shop/[1-9][0-9]{0,20}$'
        AND lower(account.configuration->>'shopDomain') ~
              '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.myshopify\\.com$'
        AND credential.external_account_id = account.external_account_id
        AND credential.auth_mode = 'shopify_client_credentials'
        AND credential.credential_version =
              account.commerce_credential_generation
        AND credential.verification_status = 'verified'
        AND activation.state IN ('shadow', 'active')
      FOR UPDATE OF account, credential, activation, membership, warehouse`,
    [
      input.organizationId,
      input.accountGlobalId,
      input.actorEmail,
      input.actorRole,
      input.warehouseGlobalId,
      input.expectedWarehouseRowVersion,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_UNAVAILABLE',
      'The exact Shopify sandbox, actor authority, activation revision, and warehouse revision are required',
      403,
    )
  }
  return row
}

type MappingPreparationRow = MappingRow & {
  warehouse_id: string
  integration_account_id: string
}

function confirmationHash(input: {
  organizationId: string
  accountGlobalId: string
  externalAccountId: string
  credentialGeneration: number
  activationRevision: number
  action: ShopifyLocationAdministrationAction
  warehouseGlobalId: string
  warehouseRowVersion: number
  mappingGlobalId: string | null
  mappingRowVersion: number | null
  providerLocationId: string | null
  statement: string
  actorEmail: string
}) {
  return hash({
    schema: SHOPIFY_LOCATION_ADMINISTRATION_CONFIRMATION_VERSION,
    ...input,
  })
}

function requestHash(input: {
  organizationId: string
  accountGlobalId: string
  externalAccountId: string
  shopDomain: string
  credentialGeneration: number
  activationState: 'shadow' | 'active'
  activationRevision: number
  action: ShopifyLocationAdministrationAction
  warehouseGlobalId: string
  warehouseRowVersion: number
  warehouseAddressHash: string
  mappingGlobalId: string | null
  mappingRowVersion: number | null
  providerLocationId: string | null
  providerSnapshotHash: string | null
  providerLocationSetHash: string | null
  desiredLocationHash: string
  reason: string
  confirmationHash: string
  idempotencyKey: string
  actorEmail: string
}) {
  return hash({
    schema: 'shopify-location-administration-request-v1',
    ...input,
  })
}

export async function prepareShopifyLocationAdministrationInPostgres(input: {
  organizationId: unknown
  actorEmail: unknown
  actorRole: unknown
  accountGlobalId: unknown
  action: unknown
  warehouseGlobalId: unknown
  expectedWarehouseRowVersion: unknown
  mappingGlobalId?: unknown
  expectedMappingRowVersion?: unknown
  providerLocation?: unknown
  providerLocationSetHash?: unknown
  providerObservedAt: unknown
  desiredLocation: unknown
  reason: unknown
  confirmationStatement: unknown
  idempotencyKey: unknown
}) {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const actorEmail = exactActor(input.actorEmail)
  const actorRole = exactRole(input.actorRole)
  const accountGlobalId = identifier(
    input.accountGlobalId,
    ACCOUNT_GLOBAL_ID,
    'Shopify account Global ID',
  )
  const action = exactAction(input.action)
  const warehouseGlobalId = identifier(
    input.warehouseGlobalId,
    WAREHOUSE_GLOBAL_ID,
    'Warehouse Global ID',
  )
  const expectedWarehouseRowVersion = exactInteger(
    input.expectedWarehouseRowVersion,
    'Warehouse row version',
  )
  const mappingGlobalId = action === 'locationAdd'
    ? null
    : identifier(
        input.mappingGlobalId,
        MAPPING_GLOBAL_ID,
        'Location mapping Global ID',
      )
  const expectedMappingRowVersion = action === 'locationAdd'
    ? null
    : exactInteger(
        input.expectedMappingRowVersion,
        'Location mapping row version',
      )
  const providerLocation = action === 'locationAdd'
    ? null
    : safeProviderLocation(input.providerLocation)
  const providerLocationSetHash = action === 'locationAdd'
    ? String(input.providerLocationSetHash || '').trim().toLowerCase()
    : null
  if (action === 'locationAdd' && !SHA256.test(providerLocationSetHash || '')) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_PROVIDER_SNAPSHOT_INVALID',
      'The exact Shopify location-set snapshot is required',
      400,
    )
  }
  const providerObservedAt = new Date(String(input.providerObservedAt || ''))
  if (!Number.isFinite(providerObservedAt.getTime())) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_PROVIDER_SNAPSHOT_INVALID',
      'The Shopify observation time is invalid',
      400,
    )
  }
  const requestedDesired = input.desiredLocation
    && typeof input.desiredLocation === 'object'
    && !Array.isArray(input.desiredLocation)
    ? input.desiredLocation as Record<string, unknown>
    : {}
  const desiredLocation = desiredFromWarehouse(
    requestedDesired.name,
    requestedDesired.address,
  )
  if (!desiredLocation) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_ADDRESS_INCOMPLETE',
      'A complete ISO-coded warehouse address is required',
      409,
    )
  }
  const desiredLocationHash = hash({
    schema: 'shopify-location-desired-v1',
    location: desiredLocation,
  })
  const authorizationReason = exactReason(input.reason)
  const statement = exactConfirmation(input.confirmationStatement)
  const expectedStatement = [
    'AUTHORIZE SHOPIFY LOCATION',
    action === 'locationAdd'
      ? 'ADD'
      : action === 'locationEdit'
        ? 'EDIT'
        : 'ACTIVATE',
    accountGlobalId,
    warehouseGlobalId,
    providerLocation?.id || 'NEW',
  ].join(' | ')
  if (statement !== expectedStatement) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_CONFIRMATION_MISMATCH',
      'Type the exact Shopify location authorization statement',
      409,
    )
  }
  const idempotencyKey = exactIdempotencyKey(input.idempotencyKey)
  const providerSnapshotHash = providerLocation
    ? hash({ schema: 'shopify-location-snapshot-v1', location: providerLocation })
    : null
  if (
    action === 'locationEdit'
    && providerLocation
    && providerMatchesDesired(providerLocation, desiredLocation)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_NO_CHANGE',
      'The Shopify location already matches this warehouse',
      409,
    )
  }
  if (action === 'locationActivate' && providerLocation) {
    if (providerLocation.isActive) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_ALREADY_ACTIVE',
        'The Shopify location is already active',
        409,
      )
    }
    if (!providerLocation.activatable) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_NOT_ACTIVATABLE',
        'Shopify reports that this merchant location cannot be activated',
        409,
      )
    }
    if (!providerMatchesDesired(providerLocation, desiredLocation)) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_LOCATION_EDIT_REQUIRED',
        'Update this Shopify location to match the mapped ClawPilot warehouse before activating it',
        409,
      )
    }
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-location-administration:prepare:${organizationId}:${accountGlobalId}:${idempotencyKey}`,
    )

    const replayResult = await client.query<AuthorizationRow>(
      `${AUTHORIZATION_SELECT}
        WHERE authz.organization_id = $1::uuid
          AND authz.integration_account_global_id = $2
          AND authz.idempotency_key = $3
        FOR UPDATE OF authz`,
      [organizationId, accountGlobalId, idempotencyKey],
    )
    if (replayResult.rows[0]) {
      const replay = authorization(replayResult.rows[0])
      const expectedConfirmationHash = confirmationHash({
        organizationId,
        accountGlobalId,
        externalAccountId: replay.externalAccountId,
        credentialGeneration: replay.credentialGeneration,
        activationRevision: replay.activationRevision,
        action,
        warehouseGlobalId,
        warehouseRowVersion: expectedWarehouseRowVersion,
        mappingGlobalId,
        mappingRowVersion: expectedMappingRowVersion,
        providerLocationId: providerLocation?.id || null,
        statement,
        actorEmail,
      })
      const mappingVersionMatches = action === 'locationAdd'
        ? replay.mappingRowVersion === null
        : replay.mappingRowVersion === expectedMappingRowVersion! + 1
      if (
        replay.authorizedBy !== actorEmail
        || replay.authorizedRole !== actorRole
        || replay.action !== action
        || replay.warehouseGlobalId !== warehouseGlobalId
        || replay.warehouseRowVersion !== expectedWarehouseRowVersion
        || replay.mappingGlobalId !== mappingGlobalId
        || !mappingVersionMatches
        || replay.providerLocationId !== (providerLocation?.id || null)
        || replay.providerSnapshotHash !== providerSnapshotHash
        || replay.providerLocationSetHash !== providerLocationSetHash
        || replay.desiredLocationHash !== desiredLocationHash
        || replay.authorizationReason !== authorizationReason
        || replay.confirmationHash !== expectedConfirmationHash
      ) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_IDEMPOTENCY_CONFLICT',
          'The Idempotency-Key was already used for different Shopify location evidence',
          409,
        )
      }
      return replay
    }

    const facts = await preparationFacts(client, {
      organizationId,
      accountGlobalId,
      actorEmail,
      actorRole,
      warehouseGlobalId,
      expectedWarehouseRowVersion,
    })
    const authoritativeDesired = desiredFromWarehouse(
      facts.warehouse_name,
      facts.warehouse_address,
    )
    if (
      !authoritativeDesired
      || canonicalJson(authoritativeDesired) !== canonicalJson(desiredLocation)
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_CHANGED',
        'The exact warehouse name or address changed before authorization',
        409,
      )
    }

    const clock = await client.query<{ prepared_at: string | Date }>(
      'SELECT clock_timestamp() AS prepared_at',
    )
    const preparedAt = new Date(clock.rows[0].prepared_at)
    if (
      providerObservedAt.getTime() < preparedAt.getTime() - 120_000
      || providerObservedAt.getTime() > preparedAt.getTime() + 60_000
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_PROVIDER_SNAPSHOT_STALE',
        'Reload Shopify locations before authorizing this action',
        409,
      )
    }

    let mapping: MappingPreparationRow | null = null
    let authorizedMappingRowVersion: number | null = null
    if (action === 'locationAdd') {
      const existing = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM operations_commerce_inventory_location_mappings mapping
            WHERE mapping.organization_id = $1::uuid
              AND mapping.warehouse_id = $2::uuid
              AND mapping.active
         ) AS exists`,
        [organizationId, facts.warehouse_id],
      )
      if (existing.rows[0]?.exists) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_WAREHOUSE_ALREADY_MAPPED',
          'This ClawPilot warehouse already has active commerce location routing',
          409,
        )
      }
    } else {
      const mappingResult = await client.query<MappingPreparationRow>(
        `SELECT mapping.id::text, mapping.global_id,
                mapping.row_version::text, mapping.external_location_id,
                mapping.external_location_name,
                mapping.warehouse_id::text,
                mapping.integration_account_id::text,
                warehouse.global_id AS warehouse_global_id,
                mapping.active, mapping.ownership_classification,
                mapping.provider_snapshot_hash,
                mapping.provider_snapshot_json,
                mapping.provider_observed_at
           FROM operations_commerce_inventory_location_mappings mapping
           JOIN operations_warehouses warehouse
             ON warehouse.organization_id = mapping.organization_id
            AND warehouse.id = mapping.warehouse_id
          WHERE mapping.organization_id = $1::uuid
            AND mapping.integration_account_id = $2::uuid
            AND mapping.global_id = $3
            AND mapping.row_version = $4::bigint
            AND mapping.warehouse_id = $5::uuid
            AND mapping.external_location_id = $6
            AND mapping.active
          FOR UPDATE OF mapping`,
        [
          organizationId,
          facts.integration_account_id,
          mappingGlobalId,
          expectedMappingRowVersion,
          facts.warehouse_id,
          providerLocation!.id,
        ],
      )
      mapping = mappingResult.rows[0] || null
      if (!mapping) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_MAPPING_CHANGED',
          'Reload the exact Shopify location mapping before authorizing a write',
          409,
        )
      }
      const updated = await client.query<{ row_version: string }>(
        `UPDATE operations_commerce_inventory_location_mappings
            SET external_location_name = $6,
                external_location_address = $7::jsonb,
                ownership_classification = 'merchant_managed',
                provider_snapshot_json = $8::jsonb,
                provider_snapshot_hash = $9,
                provider_observed_at = $10::timestamptz,
                row_version = row_version + 1,
                updated_by = $11,
                updated_at = now()
          WHERE organization_id = $1::uuid
            AND integration_account_id = $2::uuid
            AND id = $3::uuid
            AND row_version = $4::bigint
            AND external_location_id = $5
          RETURNING row_version::text`,
        [
          organizationId,
          facts.integration_account_id,
          mapping.id,
          expectedMappingRowVersion,
          providerLocation!.id,
          providerLocation!.name,
          JSON.stringify(providerLocation!.address),
          JSON.stringify(providerLocation),
          providerSnapshotHash,
          providerObservedAt.toISOString(),
          actorEmail,
        ],
      )
      if (!updated.rows[0]) {
        fail(
          'SHOPIFY_LOCATION_ADMINISTRATION_MAPPING_CHANGED',
          'The Shopify location mapping changed during authorization',
          409,
        )
      }
      authorizedMappingRowVersion = Number(updated.rows[0].row_version)
    }

    const exactConfirmationHash = confirmationHash({
      organizationId,
      accountGlobalId,
      externalAccountId: facts.external_account_id,
      credentialGeneration: Number(facts.credential_generation),
      activationRevision: Number(facts.activation_revision),
      action,
      warehouseGlobalId,
      warehouseRowVersion: expectedWarehouseRowVersion,
      mappingGlobalId,
      mappingRowVersion: expectedMappingRowVersion,
      providerLocationId: providerLocation?.id || null,
      statement,
      actorEmail,
    })
    const exactRequestHash = requestHash({
      organizationId,
      accountGlobalId,
      externalAccountId: facts.external_account_id,
      shopDomain: facts.shop_domain,
      credentialGeneration: Number(facts.credential_generation),
      activationState: facts.activation_state,
      activationRevision: Number(facts.activation_revision),
      action,
      warehouseGlobalId,
      warehouseRowVersion: expectedWarehouseRowVersion,
      warehouseAddressHash: facts.warehouse_address_hash,
      mappingGlobalId,
      mappingRowVersion: authorizedMappingRowVersion,
      providerLocationId: providerLocation?.id || null,
      providerSnapshotHash,
      providerLocationSetHash,
      desiredLocationHash,
      reason: authorizationReason,
      confirmationHash: exactConfirmationHash,
      idempotencyKey,
      actorEmail,
    })

    const inserted = await client.query<{ global_id: string }>(
      `INSERT INTO operations_shopify_location_administration_authorizations (
         organization_id, integration_account_id,
         integration_account_global_id, account_environment,
         external_account_id, shop_domain, credential_generation,
         activation_state, activation_revision, action,
         warehouse_id, warehouse_global_id, warehouse_row_version,
         warehouse_address_hash, location_mapping_id,
         location_mapping_global_id, location_mapping_row_version,
         provider_location_id, provider_snapshot_json,
         provider_snapshot_hash, provider_location_set_hash,
         provider_observed_at, desired_location_json,
         desired_location_hash, authorization_reason,
         confirmation_statement_version, confirmation_hash,
         idempotency_key, request_hash, authorized_by, authorized_role,
         prepared_at, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'sandbox', $4, $5, $6, $7, $8, $9,
         $10::uuid, $11, $12::bigint, $13, $14::uuid, $15,
         $16::bigint, $17, $18::jsonb, $19, $20, $21::timestamptz,
         $22::jsonb, $23, $24, $25, $26, $27, $28, $29, $30,
         $31::timestamptz, $31::timestamptz + interval '5 minutes'
       ) RETURNING global_id`,
      [
        organizationId,
        facts.integration_account_id,
        accountGlobalId,
        facts.external_account_id,
        facts.shop_domain,
        Number(facts.credential_generation),
        facts.activation_state,
        Number(facts.activation_revision),
        action,
        facts.warehouse_id,
        warehouseGlobalId,
        expectedWarehouseRowVersion,
        facts.warehouse_address_hash,
        mapping?.id || null,
        mappingGlobalId,
        authorizedMappingRowVersion,
        providerLocation?.id || null,
        JSON.stringify(providerLocation || {}),
        providerSnapshotHash,
        providerLocationSetHash,
        providerObservedAt.toISOString(),
        JSON.stringify(desiredLocation),
        desiredLocationHash,
        authorizationReason,
        SHOPIFY_LOCATION_ADMINISTRATION_CONFIRMATION_VERSION,
        exactConfirmationHash,
        idempotencyKey,
        exactRequestHash,
        actorEmail,
        actorRole,
        preparedAt.toISOString(),
      ],
    )
    const authorizationGlobalId = inserted.rows[0]?.global_id
    if (!authorizationGlobalId) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_CREATED',
        'Durable Shopify location authorization was not created',
        500,
      )
    }
    const created = await readAuthorizationWithClient(client, {
      organizationId,
      authorizationGlobalId,
    })
    if (!created) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_FOUND',
        'Durable Shopify location authorization was not found',
        500,
      )
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.shopify_location_administration.prepared',
      aggregateType: 'operations.shopify_location_administration_authorization',
      aggregateId: authorizationGlobalId,
      subject: accountGlobalId,
      organizationId,
      eventKey:
        `operations:shopify-location-administration:${authorizationGlobalId}:prepared`,
      payload: {
        authorizationGlobalId,
        action,
        accountGlobalId,
        warehouseGlobalId,
        mappingGlobalId,
        requestHash: exactRequestHash,
        expiresAt: created.expiresAt,
        providerWrites: 0,
      },
    }, client)
    return created
  })
}

export async function claimShopifyLocationAdministrationInPostgres(input: {
  organizationId: unknown
  actorEmail: unknown
  authorizationGlobalId: unknown
  idempotencyKey: unknown
}): Promise<ClaimedShopifyLocationAdministration> {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const actorEmail = exactActor(input.actorEmail)
  const authorizationGlobalId = identifier(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'Shopify location authorization',
  )
  const idempotencyKey = exactIdempotencyKey(input.idempotencyKey)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-location-administration:claim:${organizationId}:${authorizationGlobalId}`,
    )
    const current = await readAuthorizationWithClient(client, {
      organizationId,
      authorizationGlobalId,
      forUpdate: true,
    })
    if (!current) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_FOUND',
        'Shopify location authorization was not found',
        404,
      )
    }
    if (
      current.authorizedBy !== actorEmail
      || current.idempotencyKey !== idempotencyKey
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_ACTOR_OR_IDEMPOTENCY_MISMATCH',
        'Only the exact authorizing actor and Idempotency-Key may claim this request',
        403,
      )
    }
    if (current.status !== 'prepared') {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_ALREADY_CLAIMED',
        'This one-shot Shopify location authorization was already claimed',
        409,
      )
    }
    const currentCheck = await client.query<{
      is_current: boolean
      is_expired: boolean
    }>(
      `SELECT
         operations_shopify_location_admin_is_current($1::uuid, $2::uuid)
           AS is_current,
         $3::timestamptz <= clock_timestamp() AS is_expired`,
      [organizationId, current.authorizationId, current.expiresAt],
    )
    if (currentCheck.rows[0]?.is_expired) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_EXPIRED',
        'The five-minute Shopify location authorization expired',
        403,
      )
    }
    if (!currentCheck.rows[0]?.is_current) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_STALE',
        'The Shopify connection, activation, warehouse, mapping, or actor authority changed',
        409,
      )
    }
    const attempt = await client.query<{
      id: string
      global_id: string
      claimed_at: string | Date
    }>(
      `INSERT INTO operations_shopify_location_administration_attempts (
         organization_id, authorization_id, integration_account_id,
         action, provider_location_id, credential_generation,
         activation_revision, provider_idempotency_key, request_hash,
         claimed_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9, $10
       ) RETURNING id::text, global_id, claimed_at`,
      [
        organizationId,
        current.authorizationId,
        current.accountId,
        current.action,
        current.providerLocationId,
        current.credentialGeneration,
        current.activationRevision,
        current.providerIdempotencyKey,
        current.requestHash,
        actorEmail,
      ],
    )
    const claimedAttempt = attempt.rows[0]
    if (!claimedAttempt) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_CLAIM_FAILED',
        'Durable Shopify location authority was not claimed',
        500,
      )
    }
    const updated = await client.query<{ global_id: string }>(
      `UPDATE operations_shopify_location_administration_authorizations
          SET status = 'processing',
              provider_attempt_id = $3::uuid,
              processing_at = $4::timestamptz,
              updated_at = now()
        WHERE organization_id = $1::uuid
          AND id = $2::uuid
          AND status = 'prepared'
        RETURNING global_id`,
      [
        organizationId,
        current.authorizationId,
        claimedAttempt.id,
        iso(claimedAttempt.claimed_at),
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_CLAIM_FAILED',
        'Shopify location authority changed during claim',
        409,
      )
    }
    const claimed = await readAuthorizationWithClient(client, {
      organizationId,
      authorizationGlobalId,
    })
    if (
      !claimed
      || claimed.status !== 'processing'
      || !claimed.attemptId
      || !claimed.attemptGlobalId
      || !claimed.processingAt
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_CLAIM_FAILED',
        'Durable Shopify location claim evidence is incomplete',
        500,
      )
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.shopify_location_administration.claimed',
      aggregateType: 'operations.shopify_location_administration_authorization',
      aggregateId: authorizationGlobalId,
      subject: current.accountGlobalId,
      organizationId,
      eventKey:
        `operations:shopify-location-administration:${authorizationGlobalId}:claimed`,
      payload: {
        authorizationGlobalId,
        attemptGlobalId: claimed.attemptGlobalId,
        action: claimed.action,
        requestHash: claimed.requestHash,
        providerIdempotencyKey: claimed.providerIdempotencyKey,
        providerWrites: 0,
      },
    }, client)
    return claimed as ClaimedShopifyLocationAdministration
  })
}

function evidenceObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_INVALID',
      'Provider outcome evidence must be an object',
      400,
    )
  }
  const source = value as Record<string, unknown>
  const visit = (node: unknown, ancestors: Set<object>) => {
    if (!node || typeof node !== 'object') return
    if (ancestors.has(node)) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_INVALID',
        'Provider outcome evidence cannot be recursive',
        400,
      )
    }
    ancestors.add(node)
    try {
      if (Array.isArray(node)) {
        node.forEach((entry) => visit(entry, ancestors))
        return
      }
      for (const [key, child] of Object.entries(node)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
        if (
          normalized.includes('accesstoken')
          || normalized.includes('clientsecret')
          || normalized.includes('credentialciphertext')
        ) {
          fail(
            'SHOPIFY_LOCATION_ADMINISTRATION_EVIDENCE_NOT_REDACTED',
            'Provider outcome evidence contains a credential field',
            400,
          )
        }
        visit(child, ancestors)
      }
    } finally {
      ancestors.delete(node)
    }
  }
  visit(source, new Set())
  canonicalJson(source)
  return source
}

function exactOutcomeInput(input: {
  outcome: unknown
  providerLocationId: unknown
  providerReference: unknown
  providerWriteCount: unknown
  errorCode: unknown
}) {
  if (
    input.outcome !== 'succeeded'
    && input.outcome !== 'failed'
    && input.outcome !== 'unknown'
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_OUTCOME_INVALID',
      'Shopify location outcome is invalid',
      400,
    )
  }
  const outcome = input.outcome as 'succeeded' | 'failed' | 'unknown'
  const providerLocationId = input.providerLocationId === null
    || input.providerLocationId === undefined
    ? null
    : String(input.providerLocationId).trim()
  const providerReference = input.providerReference === null
    || input.providerReference === undefined
    ? null
    : String(input.providerReference).trim()
  const providerWriteCount = input.providerWriteCount === null
    || input.providerWriteCount === undefined
    ? null
    : Number(input.providerWriteCount)
  const errorCode = input.errorCode === null
    || input.errorCode === undefined
    ? null
    : String(input.errorCode).trim()
  const valid = (
    outcome === 'succeeded'
    && providerLocationId !== null
    && LOCATION_ID.test(providerLocationId)
    && providerWriteCount === 1
    && errorCode === null
  ) || (
    outcome === 'failed'
    && providerLocationId === null
    && providerWriteCount === 0
    && Boolean(errorCode)
  ) || (
    outcome === 'unknown'
    && providerWriteCount === null
    && Boolean(errorCode)
  )
  if (
    !valid
    || (errorCode && !/^[A-Z][A-Z0-9_]{1,127}$/u.test(errorCode))
    || (providerReference && (
      providerReference.length > 512
      || /[\u0000-\u001f\u007f]/u.test(providerReference)
    ))
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_OUTCOME_INVALID',
      'Provider outcome evidence is internally inconsistent',
      400,
    )
  }
  return {
    outcome,
    providerLocationId,
    providerReference,
    providerWriteCount: providerWriteCount as 0 | 1 | null,
    errorCode,
  }
}

async function insertTerminalOutcome(
  client: PoolClient,
  input: {
    organizationId: string
    current: ShopifyLocationAdministrationAuthorization
    actorEmail: string
    attemptGlobalId: string
    outcome: 'succeeded' | 'failed' | 'unknown'
    providerLocationId: string | null
    providerReference: string | null
    providerWriteCount: 0 | 1 | null
    errorCode: string | null
    evidence: Record<string, unknown>
  },
) {
  if (
    input.current.status !== 'processing'
    || input.current.authorizedBy !== input.actorEmail
    || input.current.attemptGlobalId !== input.attemptGlobalId
    || !input.current.attemptId
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_OUTCOME_FORBIDDEN',
      'The exact claimed Shopify location attempt is required',
      409,
    )
  }
  const evidenceHash = hash(input.evidence)
  const inserted = await client.query<{
    id: string
    global_id: string
    recorded_at: string | Date
  }>(
    `INSERT INTO operations_shopify_location_administration_outcomes (
       organization_id, authorization_id, provider_attempt_id,
       outcome_state, provider_write_count, provider_location_id,
       provider_reference, evidence_json, evidence_hash, error_code,
       recorded_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
       $8::jsonb, $9, $10, $11
     ) RETURNING id::text, global_id, recorded_at`,
    [
      input.organizationId,
      input.current.authorizationId,
      input.current.attemptId,
      input.outcome,
      input.providerWriteCount,
      input.providerLocationId,
      input.providerReference,
      JSON.stringify(input.evidence),
      evidenceHash,
      input.errorCode,
      input.actorEmail,
    ],
  )
  const outcome = inserted.rows[0]
  if (!outcome) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_OUTCOME_NOT_RECORDED',
      'Shopify location outcome was not recorded',
      500,
    )
  }
  const updated = await client.query<{ global_id: string }>(
    `UPDATE operations_shopify_location_administration_authorizations
        SET status = $4,
            latest_outcome_id = $3::uuid,
            completed_at = $5::timestamptz,
            updated_at = now()
      WHERE organization_id = $1::uuid
        AND id = $2::uuid
        AND status = 'processing'
      RETURNING global_id`,
    [
      input.organizationId,
      input.current.authorizationId,
      outcome.id,
      input.outcome,
      iso(outcome.recorded_at),
    ],
  )
  if (!updated.rows[0]) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_OUTCOME_NOT_RECORDED',
      'Shopify location authorization changed before outcome recording',
      409,
    )
  }
  return { outcomeGlobalId: outcome.global_id, evidenceHash }
}

export async function recordShopifyLocationAdministrationOutcomeInPostgres(
  input: {
    organizationId: unknown
    actorEmail: unknown
    authorizationGlobalId: unknown
    attemptGlobalId: unknown
    outcome: unknown
    providerLocationId: unknown
    providerReference: unknown
    providerWriteCount: unknown
    errorCode: unknown
    evidence: unknown
  },
) {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const actorEmail = exactActor(input.actorEmail)
  const authorizationGlobalId = identifier(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'Shopify location authorization',
  )
  const attemptGlobalId = identifier(
    input.attemptGlobalId,
    ATTEMPT_GLOBAL_ID,
    'Shopify location attempt',
  )
  const exact = exactOutcomeInput(input)
  const evidence = evidenceObject(input.evidence)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-location-administration:outcome:${organizationId}:${authorizationGlobalId}`,
    )
    const current = await readAuthorizationWithClient(client, {
      organizationId,
      authorizationGlobalId,
      forUpdate: true,
    })
    if (!current) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_FOUND',
        'Shopify location authorization was not found',
        404,
      )
    }
    const recorded = await insertTerminalOutcome(client, {
      organizationId,
      current,
      actorEmail,
      attemptGlobalId,
      outcome: exact.outcome,
      providerLocationId: exact.providerLocationId,
      providerReference: exact.providerReference,
      providerWriteCount: exact.providerWriteCount,
      errorCode: exact.errorCode!,
      evidence,
    })
    const finalized = await readAuthorizationWithClient(client, {
      organizationId,
      authorizationGlobalId,
    })
    if (!finalized || finalized.status !== exact.outcome) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_OUTCOME_NOT_RECORDED',
        'Shopify location terminal evidence is incomplete',
        500,
      )
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType:
        `operations.shopify_location_administration.${exact.outcome}`,
      aggregateType: 'operations.shopify_location_administration_authorization',
      aggregateId: authorizationGlobalId,
      subject: current.accountGlobalId,
      organizationId,
      eventKey:
        `operations:shopify-location-administration:${authorizationGlobalId}:${exact.outcome}`,
      payload: {
        authorizationGlobalId,
        attemptGlobalId,
        outcomeGlobalId: recorded.outcomeGlobalId,
        evidenceHash: recorded.evidenceHash,
        providerLocationId: exact.providerLocationId,
        providerWrites: exact.providerWriteCount,
        errorCode: exact.errorCode,
      },
    }, client)
    return finalized
  })
}

/**
 * A process can die after the durable claim and before it records the provider
 * response. After five minutes the attempt is conservatively converted to
 * unknown. It is never redispatched; the only next operation is read-only,
 * positive-only reconciliation.
 */
export async function recoverStaleShopifyLocationAdministrationInPostgres(
  input: {
    organizationId: unknown
    actorEmail: unknown
    attemptGlobalId: unknown
  },
) {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const actorEmail = exactActor(input.actorEmail)
  const attemptGlobalId = identifier(
    input.attemptGlobalId,
    ATTEMPT_GLOBAL_ID,
    'Shopify location attempt',
  )
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-location-administration:recovery:${organizationId}:${attemptGlobalId}`,
    )
    const current = await readAuthorizationWithClient(client, {
      organizationId,
      attemptGlobalId,
      forUpdate: true,
    })
    if (!current) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_FOUND',
        'Shopify location attempt was not found',
        404,
      )
    }
    if (current.authorizedBy !== actorEmail) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_ACTOR_MISMATCH',
        'Only the exact authorizing actor may recover this attempt',
        403,
      )
    }
    if (current.status !== 'processing') return current
    const stale = await client.query<{ is_stale: boolean }>(
      `SELECT $1::timestamptz + interval '5 minutes'
                <= clock_timestamp() AS is_stale`,
      [current.processingAt],
    )
    if (!stale.rows[0]?.is_stale) return current
    const evidence = {
      schema: 'shopify-location-administration-interrupted-v1',
      authorizationGlobalId: current.authorizationGlobalId,
      attemptGlobalId,
      action: current.action,
      requestHash: current.requestHash,
      providerMutationAttempted: true,
      providerWritesKnown: false,
      providerWrites: null,
      recoveredWithoutProviderMutation: true,
    }
    const recorded = await insertTerminalOutcome(client, {
      organizationId,
      current,
      actorEmail,
      attemptGlobalId,
      outcome: 'unknown',
      providerLocationId: current.providerLocationId,
      providerReference: current.providerLocationId,
      providerWriteCount: null,
      errorCode:
        'SHOPIFY_LOCATION_ADMINISTRATION_PROCESS_INTERRUPTED',
      evidence,
    })
    const recovered = await readAuthorizationWithClient(client, {
      organizationId,
      authorizationGlobalId: current.authorizationGlobalId,
    })
    if (!recovered || recovered.status !== 'unknown') {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_OUTCOME_NOT_RECORDED',
        'Interrupted Shopify location attempt was not fenced as unknown',
        500,
      )
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.shopify_location_administration.interrupted',
      aggregateType: 'operations.shopify_location_administration_authorization',
      aggregateId: current.authorizationGlobalId,
      subject: current.accountGlobalId,
      organizationId,
      eventKey:
        `operations:shopify-location-administration:${current.authorizationGlobalId}:interrupted`,
      payload: {
        authorizationGlobalId: current.authorizationGlobalId,
        attemptGlobalId,
        outcomeGlobalId: recorded.outcomeGlobalId,
        evidenceHash: recorded.evidenceHash,
        providerWrites: null,
      },
    }, client)
    return recovered
  })
}

export async function reconcileShopifyLocationAdministrationAppliedInPostgres(
  input: {
    organizationId: unknown
    actorEmail: unknown
    authorizationGlobalId: unknown
    attemptGlobalId: unknown
    providerLocationId: unknown
    providerReference: unknown
    evidence: unknown
  },
) {
  const organizationId = identifier(
    input.organizationId,
    UUID,
    'Organization ID',
  )
  const actorEmail = exactActor(input.actorEmail)
  const authorizationGlobalId = identifier(
    input.authorizationGlobalId,
    AUTHORIZATION_GLOBAL_ID,
    'Shopify location authorization',
  )
  const attemptGlobalId = identifier(
    input.attemptGlobalId,
    ATTEMPT_GLOBAL_ID,
    'Shopify location attempt',
  )
  const providerLocationId = String(input.providerLocationId || '').trim()
  const providerReference = String(input.providerReference || '').trim()
  if (
    !LOCATION_ID.test(providerLocationId)
    || providerReference.length < 1
    || providerReference.length > 512
    || /[\u0000-\u001f\u007f]/u.test(providerReference)
  ) {
    fail(
      'SHOPIFY_LOCATION_ADMINISTRATION_RECONCILIATION_INVALID',
      'Positive Shopify location reconciliation evidence is invalid',
      400,
    )
  }
  const evidence = evidenceObject(input.evidence)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-location-administration:reconcile:${organizationId}:${authorizationGlobalId}`,
    )
    const current = await readAuthorizationWithClient(client, {
      organizationId,
      authorizationGlobalId,
      forUpdate: true,
    })
    if (!current) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORIZATION_NOT_FOUND',
        'Shopify location authorization was not found',
        404,
      )
    }
    if (
      current.authorizedBy !== actorEmail
      || current.attemptGlobalId !== attemptGlobalId
    ) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RECONCILIATION_FORBIDDEN',
        'The exact authorizing actor and Shopify location attempt are required',
        403,
      )
    }
    const actorCurrent = await client.query<{ actor_current: boolean }>(
      `SELECT operations_shopify_location_admin_actor_current(
         $1::uuid, $2, $3
       ) AS actor_current`,
      [organizationId, actorEmail, current.authorizedRole],
    )
    if (!actorCurrent.rows[0]?.actor_current) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORITY_REQUIRED',
        'Current owner or administrator authority is required to reconcile',
        403,
      )
    }
    if (current.status === 'reconciled') return current
    if (current.status !== 'unknown' || !current.attemptId) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RECONCILIATION_NOT_ALLOWED',
        'Only an unknown Shopify location attempt can be reconciled',
        409,
      )
    }
    const evidenceHash = hash(evidence)
    const inserted = await client.query<{
      id: string
      global_id: string
      recorded_at: string | Date
    }>(
      `INSERT INTO operations_shopify_location_administration_outcomes (
         organization_id, authorization_id, provider_attempt_id,
         outcome_state, reconciliation_resolution, provider_write_count,
         provider_location_id, provider_reference, evidence_json,
         evidence_hash, error_code, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'reconciled', 'confirmed_applied',
         NULL, $4, $5, $6::jsonb, $7, NULL, $8
       ) RETURNING id::text, global_id, recorded_at`,
      [
        organizationId,
        current.authorizationId,
        current.attemptId,
        providerLocationId,
        providerReference,
        JSON.stringify(evidence),
        evidenceHash,
        actorEmail,
      ],
    )
    const outcome = inserted.rows[0]
    if (!outcome) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RECONCILIATION_NOT_RECORDED',
        'Positive Shopify location reconciliation was not recorded',
        500,
      )
    }
    const updated = await client.query<{ global_id: string }>(
      `UPDATE operations_shopify_location_administration_authorizations
          SET status = 'reconciled',
              latest_outcome_id = $3::uuid,
              completed_at = $4::timestamptz,
              updated_at = now()
        WHERE organization_id = $1::uuid
          AND id = $2::uuid
          AND status = 'unknown'
        RETURNING global_id`,
      [
        organizationId,
        current.authorizationId,
        outcome.id,
        iso(outcome.recorded_at),
      ],
    )
    if (!updated.rows[0]) {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RECONCILIATION_NOT_RECORDED',
        'Shopify location authorization changed during reconciliation',
        409,
      )
    }
    const finalized = await readAuthorizationWithClient(client, {
      organizationId,
      authorizationGlobalId,
    })
    if (!finalized || finalized.status !== 'reconciled') {
      fail(
        'SHOPIFY_LOCATION_ADMINISTRATION_RECONCILIATION_NOT_RECORDED',
        'Positive Shopify location reconciliation evidence is incomplete',
        500,
      )
    }
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.shopify_location_administration.reconciled',
      aggregateType: 'operations.shopify_location_administration_authorization',
      aggregateId: authorizationGlobalId,
      subject: current.accountGlobalId,
      organizationId,
      eventKey:
        `operations:shopify-location-administration:${authorizationGlobalId}:reconciled`,
      payload: {
        authorizationGlobalId,
        attemptGlobalId,
        outcomeGlobalId: outcome.global_id,
        evidenceHash,
        resolution: 'confirmed_applied',
        providerLocationId,
        providerWrites: null,
        providerMutationsDuringReconciliation: 0,
      },
    }, client)
    return finalized
  })
}
