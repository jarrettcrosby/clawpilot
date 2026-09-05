#!/usr/bin/env node

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')

export const SCRIPT_VERSION = 'ag-alchemy-wwex-sandbox-shop-acceptance-v1'
export const EXECUTION_CONFIRMATION =
  'run-ag-alchemy-wwex-sandbox-shop-acceptance-v1'
export const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
export const TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
export const TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'
export const TARGET_WAREHOUSE_GLOBAL_ID = 'gwh5366613'
export const TARGET_WAREHOUSE_CODE = 'AG-ALCHEMY-01'

const PROVIDER = 'wwex_speedship'
const ENVIRONMENT = 'sandbox'
const PROVIDER_ENDPOINTS = Object.freeze({
  token: 'https://auth.staging-wwex.com/oauth/token',
  shop: 'https://speedship.staging-wwex.com/svc/shopFlow',
})
const MODES = Object.freeze(['small_parcel', 'ltl'])
const MODE_CAPABILITY = Object.freeze({
  small_parcel: 'small_parcel_rate',
  ltl: 'ltl_rate',
})
const MUTATION_EVIDENCE_TABLES = Object.freeze([
  'operations_carrier_rate_requests',
  'operations_one_off_parcel_pickup_attempts',
  'operations_freight_tender_attempts',
  'operations_freight_tender_documents',
  'operations_shipments',
  'operations_labels',
  'operations_print_artifacts',
  'operations_print_jobs',
])
const SHA256 = /^[a-f0-9]{64}$/

// These contacts are ephemeral provider-sandbox diagnostics. Warehouse street,
// locality, region, postal code, country, name, and identity are always loaded
// from the trusted AG warehouse row and are never written back or printed.
const SANDBOX_ORIGIN_CONTACT = Object.freeze({
  firstName: 'AG',
  lastName: 'Warehouse',
  phone: '4025550100',
  email: 'warehouse@example.test',
})
const SANDBOX_DESTINATION = Object.freeze({
  line1: '35 Saxony Drive',
  line2: null,
  locality: 'Trumbull',
  region: 'CT',
  postalCode: '06611',
  countryCode: 'US',
  companyName: 'WWEX Sandbox Receiver',
  phone: '2035550101',
  contact: Object.freeze({
    firstName: 'WWEX',
    lastName: 'Receiver',
    phone: '2035550101',
    email: 'receiver@example.test',
  }),
  residential: true,
  locationType: 'RESIDENTIAL',
})

export class AcceptanceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AcceptanceError'
    this.code = code
  }
}

function fail(code, message) {
  throw new AcceptanceError(code, message)
}

export function summarizeAcceptanceCompletion(modes) {
  if (!Array.isArray(modes) || modes.length !== MODES.length) {
    fail(
      'ACCEPTANCE_MODE_RESULTS_INCOMPLETE',
      'Worldwide Express acceptance did not return every intended mode',
    )
  }
  const byMode = new Map()
  for (const result of modes) {
    if (
      !result
      || !MODES.includes(result.mode)
      || byMode.has(result.mode)
      || !['succeeded', 'failed', 'skipped'].includes(result.outcome)
    ) {
      fail(
        'ACCEPTANCE_MODE_RESULTS_INVALID',
        'Worldwide Express acceptance returned an invalid mode result',
      )
    }
    byMode.set(result.mode, result)
  }
  if (MODES.some((mode) => !byMode.has(mode))) {
    fail(
      'ACCEPTANCE_MODE_RESULTS_INCOMPLETE',
      'Worldwide Express acceptance did not return every intended mode',
    )
  }
  const attemptedModeCount = modes.filter(
    (result) => result.outcome !== 'skipped',
  ).length
  const failedModeCount = modes.filter(
    (result) => result.outcome === 'failed',
  ).length
  const succeededModeCount = modes.filter(
    (result) => result.outcome === 'succeeded',
  ).length
  const skippedModeCount = modes.length - attemptedModeCount
  return {
    ok: succeededModeCount === MODES.length,
    completionStatus: failedModeCount > 0
      ? 'failed'
      : skippedModeCount > 0
        ? 'blocked'
        : 'complete',
    attemptedModeCount,
    succeededModeCount,
    failedModeCount,
    skippedModeCount,
  }
}

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, dependencies = {}) {
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length > 0) {
    fail(
      'ACCEPTANCE_RUNTIME_MODULE_INVALID',
      'The reviewed Worldwide Express runtime could not be loaded',
    )
  }
  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
    return nodeRequire(specifier)
  }
  vm.runInNewContext(result.outputText, {
    AbortController,
    AbortSignal,
    Array,
    BigInt,
    Boolean,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Response,
    Set,
    String,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    require: localRequire,
    setTimeout,
  }, { filename: path })
  return module.exports
}

const credentialCrypto = loadTypeScriptModule(
  'app_src/lib/integrations/brokeredTransportCredentialCrypto.ts',
  {
    './integrationCredentialRuntimeGate.mjs':
      integrationCredentialRuntimeGate,
  },
)
const wwexFoundation = loadTypeScriptModule(
  'app_src/lib/integrations/wwexSpeedshipFoundation.ts',
)
const wwexClient = loadTypeScriptModule(
  'app_src/lib/integrations/wwexSpeedshipClient.ts',
  {
    '@/lib/integrations/brokeredTransportCredentialCrypto': credentialCrypto,
    '@/lib/integrations/wwexSpeedshipFoundation': wwexFoundation,
  },
)

function environmentValue(name) {
  return String(process.env[name] || '').trim()
}

function requireTrustedDevelopmentEnvironment() {
  if (
    environmentValue('RAILWAY_PROJECT_ID') !== TRUSTED_RAILWAY_PROJECT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_ID')
      !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_NAME') !== 'development'
  ) {
    fail(
      'ACCEPTANCE_ENVIRONMENT_FORBIDDEN',
      'Execution is restricted to the trusted ClawPilot Railway development environment',
    )
  }
}

function postgresConnectionString(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('ACCEPTANCE_DATABASE_URL_INVALID', 'DATABASE_URL is invalid')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail(
      'ACCEPTANCE_DATABASE_URL_INVALID',
      'DATABASE_URL must use PostgreSQL',
    )
  }
  url.searchParams.delete('sslmode')
  return url.toString()
}

function loadExecutionConfiguration() {
  // Environment identity is checked before any secret-bearing value is read.
  requireTrustedDevelopmentEnvironment()
  const databaseUrl = environmentValue('DATABASE_PUBLIC_URL')
    || environmentValue('DATABASE_URL')
  if (!databaseUrl) {
    fail(
      'ACCEPTANCE_DATABASE_URL_REQUIRED',
      'DATABASE_PUBLIC_URL or DATABASE_URL is required',
    )
  }
  const encryptionKey = environmentValue(
    'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY',
  ) || environmentValue('AGENT_CREDENTIAL_ENCRYPTION_KEY')
  if (encryptionKey.length < 32) {
    fail(
      'ACCEPTANCE_CREDENTIAL_DECRYPTION_UNAVAILABLE',
      'Brokered transport credential decryption is not configured',
    )
  }
  const normalizedDatabaseUrl = postgresConnectionString(databaseUrl)
  return {
    databaseUrl: normalizedDatabaseUrl,
    ssl: new URL(normalizedDatabaseUrl).hostname.endsWith('rlwy.net'),
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
}

function strings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string')
    : []
}

function requiredAddressText(source, keys, label, maximum = 160) {
  const value = keys
    .map((key) => source[key])
    .find((candidate) => typeof candidate === 'string' && candidate.trim())
  const normalized = String(value || '').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maximum) {
    fail(
      'ACCEPTANCE_TARGET_WAREHOUSE_ADDRESS_INVALID',
      `The AG Alchemy warehouse ${label} is missing or invalid`,
    )
  }
  return normalized
}

function warehouseOrigin(warehouse, mode) {
  const source = object(warehouse.address)
  const countryCode = requiredAddressText(
    source,
    ['countryCode', 'country'],
    'country',
    2,
  ).toUpperCase()
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    fail(
      'ACCEPTANCE_TARGET_WAREHOUSE_ADDRESS_INVALID',
      'The AG Alchemy warehouse country is invalid',
    )
  }
  return {
    line1: requiredAddressText(source, ['line1', 'street'], 'street'),
    line2: typeof source.line2 === 'string' && source.line2.trim()
      ? source.line2.trim()
      : null,
    locality: requiredAddressText(source, ['city', 'locality'], 'city', 100),
    region: requiredAddressText(source, ['region', 'state'], 'region', 3)
      .toUpperCase(),
    postalCode: requiredAddressText(
      source,
      ['postalCode', 'postal_code'],
      'postal code',
      16,
    ),
    countryCode,
    companyName: warehouse.name,
    phone: SANDBOX_ORIGIN_CONTACT.phone,
    contact: SANDBOX_ORIGIN_CONTACT,
    residential: false,
    locationType: mode === 'small_parcel' ? 'OTHER' : 'COMMERCIAL',
  }
}

function nextBusinessShipmentDate(now = new Date()) {
  const date = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 2,
  ))
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return `${date.toISOString().slice(0, 10)} 10:30:00`
}

function diagnosticId(mode, date) {
  const compactDate = date.slice(0, 10).replaceAll('-', '')
  return `ag-alchemy:wwex:${mode}:${compactDate}`
}

export function prepareDiagnosticShopRequest(input) {
  const shipmentDate = nextBusinessShipmentDate(input.now)
  const common = {
    credentialVersion: input.credentialVersion,
    credentialFingerprint: input.credentialFingerprint,
    planId: `${diagnosticId(input.mode, shipmentDate)}:plan`,
    correlationId: `${diagnosticId(input.mode, shipmentDate)}:acceptance`,
    shipmentDate,
    origin: warehouseOrigin(input.warehouse, input.mode),
    destination: { ...SANDBOX_DESTINATION },
  }
  if (input.mode === 'small_parcel') {
    return wwexFoundation.prepareWwexSmallpackShopRequest({
      ...common,
      shipmentDescription: 'AG Alchemy read-only WWEX sandbox acceptance',
      packages: [{
        packageKey: 'acceptance-carton-1',
        packagingType: '02',
        length: 12,
        width: 10,
        height: 6,
        weight: 5,
      }],
      deliveryConfirmation: false,
      carbonNeutral: false,
      adultSignatureRequired: false,
      signatureRequired: false,
      shipperRelease: false,
      selfScheduled: false,
      returnLabel: false,
      returnServiceType: null,
    })
  }
  return wwexFoundation.prepareWwexLtlShopRequest({
    ...common,
    pallets: [{
      palletKey: 'acceptance-pallet-1',
      length: 48,
      width: 40,
      height: 48,
      weight: 500,
      isStackable: true,
      isMixedClass: false,
      marksAndNumbers: 'AG-WWEX-ACCEPTANCE',
      commodities: [{
        commodityKey: 'acceptance-commodity-1',
        commodityClass: '85',
        description: 'Non-hazardous sandbox test goods',
        packagingType: 'CARTON',
        quantity: 20,
        weight: 460,
      }],
    }],
    accessorials: {
      appointmentDelivery: false,
      deliveryConfirmation: false,
      directDeliveryOnly: false,
      holdAtTerminal: false,
      insideDelivery: false,
      insidePickup: false,
      carrierTerminalPickup: false,
      liftgateDelivery: false,
      liftgatePickup: false,
      notifyBeforeDelivery: false,
      protectionFromCold: false,
      protectionFromHeat: false,
      signatureRequired: false,
      sortAndSegregate: false,
      tradeshowDelivery: false,
      tradeshowPickup: false,
    },
  })
}

export function createProviderFetchGate(mode, baseFetch = fetch) {
  if (!MODES.includes(mode)) {
    fail('ACCEPTANCE_MODE_INVALID', 'Worldwide Express acceptance mode is invalid')
  }
  const calls = { token: 0, shop: 0 }
  const guardedFetch = async (urlValue, init = {}) => {
    const url = String(urlValue)
    if (url === PROVIDER_ENDPOINTS.token) {
      calls.token += 1
      if (
        calls.token !== 1
        || init.method !== 'POST'
        || init.redirect !== 'error'
      ) {
        fail(
          'ACCEPTANCE_PROVIDER_REQUEST_FORBIDDEN',
          'Unexpected Worldwide Express token request',
        )
      }
      const body = new URLSearchParams(String(init.body || ''))
      if (
        body.get('grant_type') !== 'client_credentials'
        || body.get('audience') !== 'staging-wwex-apig'
      ) {
        fail(
          'ACCEPTANCE_PROVIDER_REQUEST_FORBIDDEN',
          'Unexpected Worldwide Express token request',
        )
      }
      return baseFetch(urlValue, init)
    }
    if (url === PROVIDER_ENDPOINTS.shop) {
      calls.shop += 1
      if (
        calls.shop !== 1
        || init.method !== 'POST'
        || init.redirect !== 'error'
      ) {
        fail(
          'ACCEPTANCE_PROVIDER_REQUEST_FORBIDDEN',
          'Unexpected Worldwide Express shop request',
        )
      }
      let productType = null
      try {
        productType = JSON.parse(String(init.body || '')).request?.productType
      } catch {
        // The request is rejected below without forwarding it.
      }
      const expectedProductType = mode === 'small_parcel' ? 'SMALLPACK' : 'LTL'
      if (productType !== expectedProductType) {
        fail(
          'ACCEPTANCE_PROVIDER_REQUEST_FORBIDDEN',
          'Unexpected Worldwide Express shop product type',
        )
      }
      return baseFetch(urlValue, init)
    }
    fail(
      'ACCEPTANCE_PROVIDER_REQUEST_FORBIDDEN',
      'Only Worldwide Express OAuth and read-only shopFlow are allowed',
    )
  }
  return { fetch: guardedFetch, calls }
}

function modeBlockers(account, mode) {
  if (!account) return ['wwex_sandbox_account_not_found']
  const blockers = []
  const configuration = object(account.configuration)
  const capabilities = strings(configuration.allowedCapabilities)
  const activation = object(object(configuration.transportActivation)[mode])
  if (account.account_status !== 'active') blockers.push('account_not_active')
  if (!account.credential_configured) blockers.push('credential_not_configured')
  if (account.verification_status !== 'verified') {
    blockers.push('credential_not_verified')
  }
  if (configuration.activationStatus !== 'active') {
    blockers.push('activation_not_active')
  }
  if (strings(configuration.activationBlockers).length > 0) {
    blockers.push('activation_blockers_present')
  }
  if (!capabilities.includes(MODE_CAPABILITY[mode])) {
    blockers.push(`${mode}_rate_capability_not_allowed`)
  }
  if (activation.ratingEnabled !== true) {
    blockers.push(`${mode}_rating_not_enabled`)
  }
  return blockers
}

async function assertTrustedDatabase(client) {
  const result = await client.query(
    `SELECT value ->> 'id' AS database_fingerprint
     FROM app_settings
     WHERE key = 'deployment.database.identity'`,
  )
  if (
    result.rowCount !== 1
    || result.rows[0]?.database_fingerprint
      !== TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT
  ) {
    fail(
      'ACCEPTANCE_DATABASE_IDENTITY_MISMATCH',
      'Connected database is not the trusted ClawPilot development database',
    )
  }
}

async function loadTarget(client) {
  const organizationResult = await client.query(
    `SELECT id::text, name
     FROM workspace_organizations
     WHERE name = $1
     ORDER BY id`,
    [TARGET_ORGANIZATION_NAME],
  )
  if (organizationResult.rowCount !== 1) {
    fail(
      'ACCEPTANCE_TARGET_ORGANIZATION_INVALID',
      'Exactly one AG Alchemy workspace is required',
    )
  }
  const organization = organizationResult.rows[0]
  const warehouseResult = await client.query(
    `SELECT warehouse.id::text, warehouse.global_id, warehouse.code,
            warehouse.name, warehouse.address, warehouse.status
     FROM operations_warehouses warehouse
     WHERE warehouse.organization_id = $1::uuid
       AND warehouse.global_id = $2`,
    [organization.id, TARGET_WAREHOUSE_GLOBAL_ID],
  )
  const warehouse = warehouseResult.rows[0]
  if (
    warehouseResult.rowCount !== 1
    || warehouse.code !== TARGET_WAREHOUSE_CODE
    || warehouse.status !== 'active'
  ) {
    fail(
      'ACCEPTANCE_TARGET_WAREHOUSE_INVALID',
      'The exact active AG Alchemy warehouse is required',
    )
  }
  // Validate address fields before any provider call. Returned evidence never
  // contains the resulting origin or contact details.
  warehouseOrigin(warehouse, 'small_parcel')
  warehouseOrigin(warehouse, 'ltl')
  return { organization, warehouse }
}

async function loadWwexSandboxAccount(client, organizationId) {
  const result = await client.query(
    `SELECT account.id::text AS integration_account_id,
            account.global_id AS integration_global_id,
            account.status AS account_status,
            account.configuration,
            credential.credential_ciphertext,
            credential.credential_iv,
            credential.credential_tag,
            credential.credential_version,
            credential.credential_fingerprint,
            credential.credential_kind,
            credential.verification_status,
            (
              credential.credential_ciphertext IS NOT NULL
              AND credential.credential_iv IS NOT NULL
              AND credential.credential_tag IS NOT NULL
              AND credential.credential_version IS NOT NULL
              AND credential.credential_fingerprint IS NOT NULL
            ) AS credential_configured
     FROM operations_integration_accounts account
     LEFT JOIN operations_carrier_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.provider = $2
       AND account.environment = $3
     ORDER BY account.id`,
    [organizationId, PROVIDER, ENVIRONMENT],
  )
  if (result.rowCount > 1) {
    fail(
      'ACCEPTANCE_WWEX_ACCOUNT_AMBIGUOUS',
      'More than one AG Alchemy Worldwide Express sandbox account exists',
    )
  }
  return result.rows[0] || null
}

async function verifiedWwexSandboxAccountScope(client, targetOrganizationId) {
  const result = await client.query(
    `SELECT count(*) FILTER (
              WHERE account.organization_id = $3::uuid
            )::integer AS target_verified_account_count,
            count(*) FILTER (
              WHERE account.organization_id <> $3::uuid
            )::integer AS outside_target_verified_account_count
     FROM operations_integration_accounts account
     JOIN operations_carrier_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE account.integration_type = 'carrier'
       AND account.provider = $1
       AND account.environment = $2
       AND credential.verification_status = 'verified'
       AND credential.credential_ciphertext IS NOT NULL
       AND credential.credential_iv IS NOT NULL
       AND credential.credential_tag IS NOT NULL`,
    [PROVIDER, ENVIRONMENT, targetOrganizationId],
  )
  return {
    targetVerifiedAccountCount: Number(
      result.rows[0]?.target_verified_account_count || 0,
    ),
    outsideTargetVerifiedAccountCount: Number(
      result.rows[0]?.outside_target_verified_account_count || 0,
    ),
  }
}

async function countSnapshot(client, organizationId) {
  const result = {}
  for (const table of MUTATION_EVIDENCE_TABLES) {
    const existence = await client.query(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [`public.${table}`],
    )
    if (existence.rows[0]?.exists !== true) {
      result[table] = null
      continue
    }
    const count = await client.query(
      `SELECT count(*)::bigint AS count FROM ${table}
       WHERE organization_id = $1::uuid`,
      [organizationId],
    )
    result[table] = String(count.rows[0].count)
  }
  return result
}

function countEvidence(before, after) {
  return MUTATION_EVIDENCE_TABLES.map((table) => ({
    table,
    present: before[table] !== null,
    unchanged: before[table] === after[table],
  }))
}

function runtimeCredential(account, organizationId) {
  if (
    account.credential_kind !== 'oauth_client_credentials'
    || !Number.isSafeInteger(Number(account.credential_version))
    || Number(account.credential_version) < 1
    || !SHA256.test(String(account.credential_fingerprint || ''))
  ) {
    fail(
      'ACCEPTANCE_CREDENTIAL_BINDING_INVALID',
      'The stored Worldwide Express sandbox credential binding is invalid',
    )
  }
  let credential
  try {
    credential = credentialCrypto.decryptBrokeredTransportCredential({
      ciphertext: account.credential_ciphertext,
      iv: account.credential_iv,
      tag: account.credential_tag,
    }, organizationId, PROVIDER, ENVIRONMENT)
  } catch {
    fail(
      'ACCEPTANCE_CREDENTIAL_DECRYPTION_FAILED',
      'The stored Worldwide Express sandbox credential could not be decrypted',
    )
  }
  return {
    provider: PROVIDER,
    environment: ENVIRONMENT,
    credentialVersion: Number(account.credential_version),
    credentialFingerprint: account.credential_fingerprint,
    credential,
  }
}

function sanitizedModeError(error) {
  if (error instanceof wwexClient.WwexSpeedshipClientError) {
    return {
      code: error.code,
      status: error.status,
      providerOutcome: error.providerOutcome,
    }
  }
  if (error instanceof AcceptanceError) {
    return { code: error.code, status: null, providerOutcome: 'failed' }
  }
  return {
    code: 'ACCEPTANCE_WWEX_SHOP_FAILED',
    status: null,
    providerOutcome: 'failed',
  }
}

async function executeMode(input) {
  const prepared = prepareDiagnosticShopRequest({
    mode: input.mode,
    warehouse: input.warehouse,
    credentialVersion: input.runtimeCredential.credentialVersion,
    credentialFingerprint: input.runtimeCredential.credentialFingerprint,
    now: input.now,
  })
  const gate = createProviderFetchGate(input.mode, input.fetchImpl || fetch)
  try {
    const execution = await wwexClient.executeWwexSpeedshipShopRequest({
      preparedRequest: prepared,
      runtimeCredential: input.runtimeCredential,
      fetchImpl: gate.fetch,
      timeoutMs: 30_000,
    })
    const carriers = [...new Set(execution.result.offers.map(
      (offer) => offer.executingCarrier.scac,
    ))].sort()
    return {
      mode: input.mode,
      outcome: 'succeeded',
      providerHttpStatus: execution.providerHttpStatus,
      offerCount: execution.result.offers.length,
      eligibleOfferCount: execution.result.offers.filter(
        (offer) => offer.eligible,
      ).length,
      executingCarrierScacs: carriers,
      requestHash: execution.requestHash,
      resultHash: execution.result.resultHash,
      networkCalls: { ...gate.calls },
      providerMutationCount: prepared.providerMutationCount,
    }
  } catch (error) {
    return {
      mode: input.mode,
      outcome: 'failed',
      error: sanitizedModeError(error),
      networkCalls: { ...gate.calls },
      providerMutationCount: prepared.providerMutationCount,
    }
  }
}

function createPool(configuration) {
  return new Pool({
    connectionString: configuration.databaseUrl,
    ssl: configuration.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    max: 1,
  })
}

export async function executeAcceptance(options = {}) {
  const configuration = loadExecutionConfiguration()
  const pool = createPool(configuration)
  let client = null
  let transactionOpen = false
  let executionStage = 'database_connect'
  try {
    client = await pool.connect()
    executionStage = 'database_read_only_transaction'
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    )
    transactionOpen = true
    const transactionState = await client.query(
      `SELECT current_setting('transaction_read_only') AS read_only,
              current_setting('transaction_isolation') AS isolation`,
    )
    if (
      transactionState.rows[0]?.read_only !== 'on'
      || transactionState.rows[0]?.isolation !== 'repeatable read'
    ) {
      fail(
        'ACCEPTANCE_DATABASE_TRANSACTION_UNSAFE',
        'The acceptance database transaction is not repeatable-read and read-only',
      )
    }
    executionStage = 'database_identity_check'
    await assertTrustedDatabase(client)
    executionStage = 'target_workspace_read'
    const target = await loadTarget(client)
    executionStage = 'wwex_account_read'
    const account = await loadWwexSandboxAccount(
      client,
      target.organization.id,
    )
    const verifiedAccountScope = await verifiedWwexSandboxAccountScope(
      client,
      target.organization.id,
    )
    executionStage = 'database_before_count_read'
    const before = await countSnapshot(client, target.organization.id)
    const blockers = Object.fromEntries(
      MODES.map((mode) => [mode, modeBlockers(account, mode)]),
    )
    const modes = []
    const executableModes = MODES.filter((mode) => blockers[mode].length === 0)
    let credential = null
    if (executableModes.length > 0) {
      executionStage = 'credential_decryption'
      credential = runtimeCredential(account, target.organization.id)
    }
    for (const mode of MODES) {
      if (blockers[mode].length > 0) {
        modes.push({
          mode,
          outcome: 'skipped',
          reasons: blockers[mode],
          networkCalls: { token: 0, shop: 0 },
          providerMutationCount: 0,
        })
        continue
      }
      executionStage = `${mode}_shop_flow`
      modes.push(await executeMode({
        mode,
        warehouse: target.warehouse,
        runtimeCredential: credential,
        fetchImpl: options.fetchImpl,
        now: options.now,
      }))
    }
    executionStage = 'database_after_count_read'
    const after = await countSnapshot(client, target.organization.id)
    const databaseCounts = countEvidence(before, after)
    if (databaseCounts.some((entry) => entry.unchanged !== true)) {
      fail(
        'ACCEPTANCE_DATABASE_COUNTS_CHANGED',
        'A relevant database count changed during the read-only acceptance',
      )
    }
    executionStage = 'database_read_only_commit'
    await client.query('COMMIT')
    transactionOpen = false
    const completion = summarizeAcceptanceCompletion(modes)
    executionStage = 'complete'
    return {
      ok: completion.ok,
      completionStatus: completion.completionStatus,
      scriptVersion: SCRIPT_VERSION,
      mode: 'execute',
      target: {
        organizationVerified: true,
        warehouseGlobalId: TARGET_WAREHOUSE_GLOBAL_ID,
        warehouseCode: TARGET_WAREHOUSE_CODE,
      },
      provider: PROVIDER,
      environment: ENVIRONMENT,
      credentialDetected: Boolean(account?.credential_configured),
      accountDetected: Boolean(account),
      verifiedSandboxAccountScope: verifiedAccountScope,
      attemptedModeCount: completion.attemptedModeCount,
      succeededModeCount: completion.succeededModeCount,
      failedModeCount: completion.failedModeCount,
      skippedModeCount: completion.skippedModeCount,
      modes,
      safety: {
        databaseTransaction: 'repeatable read read only',
        databaseWritesPermitted: false,
        databaseCountChecks: databaseCounts,
        allowedProviderEndpoints: ['oauth_token', 'shopFlow'],
        tenderCalls: 0,
        pickupCalls: 0,
        labelCalls: 0,
        providerMutationCount: 0,
        persistentFixturesCreated: 0,
      },
    }
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    throw new AcceptanceError(
      `ACCEPTANCE_${executionStage.toUpperCase()}_FAILED`,
      `Worldwide Express acceptance failed during ${executionStage.replaceAll('_', ' ')}`,
    )
  } finally {
    if (transactionOpen && client) {
      await client.query('ROLLBACK').catch(() => undefined)
    }
    client?.release()
    await pool.end().catch(() => undefined)
  }
}

function fixtureWarehouse() {
  return {
    global_id: TARGET_WAREHOUSE_GLOBAL_ID,
    code: TARGET_WAREHOUSE_CODE,
    name: 'AG Alchemy mock shipping warehouse',
    address: {
      name: 'AG Alchemy mock shipping warehouse',
      line1: '7009 S 108th St',
      line2: null,
      city: 'La Vista',
      region: 'NE',
      postalCode: '68128',
      country: 'US',
    },
  }
}

function mockShopResponse(mode, date) {
  const expiration = `${date.slice(0, 10)} 23:00:00`
  if (mode === 'small_parcel') {
    return {
      apiVersion: '1.9b',
      clientStatus: { success: true, message: 'Success' },
      correlationId: 'self-test-small-parcel',
      response: {
        productTransactionId: 'self-test-small-transaction',
        offerList: [{
          primaryVendor: {
            vendorId: 'UPS',
            preferredName: 'United Parcel Service',
            scac: 'UPSN',
          },
          offerId: 'self-test-small-offer',
          expirationDate: expiration,
          offeredProductList: [{
            offeredProductId: 'self-test-small-product',
            offerPrice: { value: '10.00', unit: 'USD' },
            chargeItemList: [],
            shopRQShipment: {
              timeInTransit: {
                upsServiceCode: 'GND',
                serviceDescription: 'UPS Ground',
                transitDays: 3,
                estimatedDeliveryDate: date.slice(0, 10),
              },
            },
          }],
        }],
      },
    }
  }
  return {
    apiVersion: '1.9b',
    clientStatus: { success: true, message: 'Success' },
    correlationId: 'self-test-ltl',
    response: {
      productTransactionId: 'self-test-ltl-transaction',
      offerList: [{
        primaryVendor: {
          vendorId: 'RLCA',
          preferredName: 'R+L Carriers',
          scac: 'RLCA',
        },
        offerId: 'self-test-ltl-offer',
        expirationDate: expiration,
        offeredProductList: [{
          offeredProductId: 'self-test-ltl-product',
          offerPrice: { value: '100.00', unit: 'USD' },
          serviceDetail: { name: 'DEFAULT' },
          chargeItemList: [],
          shopRQShipment: {
            timeInTransit: {
              serviceLevel: 'STANDARD',
              transitDays: 4,
              estimatedDeliveryDate: date.slice(0, 10),
            },
          },
        }],
      }],
    },
  }
}

export async function selfTest() {
  const clientSecretCanary = 'self-test-secret-must-never-be-printed'
  const runtime = {
    provider: PROVIDER,
    environment: ENVIRONMENT,
    credentialVersion: 1,
    credentialFingerprint: 'a'.repeat(64),
    credential: {
      authKind: 'oauth_client_credentials',
      clientId: 'self-test-client',
      clientSecret: clientSecretCanary,
      audience: 'staging-wwex-apig',
    },
  }
  const now = new Date('2026-08-12T12:00:00.000Z')
  const warehouse = fixtureWarehouse()
  const results = []
  for (const mode of MODES) {
    let call = 0
    const fakeFetch = async (url) => {
      call += 1
      if (String(url) === PROVIDER_ENDPOINTS.token) {
        return new Response(JSON.stringify({
          access_token: 'self-test-access-token-value',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const prepared = prepareDiagnosticShopRequest({
        mode,
        warehouse,
        credentialVersion: runtime.credentialVersion,
        credentialFingerprint: runtime.credentialFingerprint,
        now,
      })
      return new Response(JSON.stringify(
        mockShopResponse(mode, prepared.evidence.shipmentDate),
      ), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const result = await executeMode({
      mode,
      warehouse,
      runtimeCredential: runtime,
      fetchImpl: fakeFetch,
      now,
    })
    if (
      result.outcome !== 'succeeded'
      || result.networkCalls.token !== 1
      || result.networkCalls.shop !== 1
      || result.providerMutationCount !== 0
      || call !== 2
    ) {
      fail(
        'ACCEPTANCE_SELF_TEST_FAILED',
        'The hermetic Worldwide Express shop-flow self-test failed',
      )
    }
    results.push(result)
  }
  const forbiddenGate = createProviderFetchGate(
    'small_parcel',
    async () => {
      fail(
        'ACCEPTANCE_SELF_TEST_FAILED',
        'Forbidden provider endpoint reached the network stub',
      )
    },
  )
  let forbiddenBlocked = false
  try {
    await forbiddenGate.fetch(
      'https://speedship.staging-wwex.com/svc/integratedOrderFlow',
      { method: 'POST', redirect: 'error' },
    )
  } catch (error) {
    forbiddenBlocked = error instanceof AcceptanceError
      && error.code === 'ACCEPTANCE_PROVIDER_REQUEST_FORBIDDEN'
  }
  if (!forbiddenBlocked) {
    fail(
      'ACCEPTANCE_SELF_TEST_FAILED',
      'The provider mutation endpoint guard failed',
    )
  }
  const allSkippedCompletion = summarizeAcceptanceCompletion(
    MODES.map((mode) => ({
      mode,
      outcome: 'skipped',
      reasons: ['wwex_sandbox_account_not_found'],
    })),
  )
  if (
    allSkippedCompletion.ok !== false
    || allSkippedCompletion.completionStatus !== 'blocked'
    || allSkippedCompletion.attemptedModeCount !== 0
    || allSkippedCompletion.skippedModeCount !== MODES.length
  ) {
    fail(
      'ACCEPTANCE_SELF_TEST_FAILED',
      'An all-skipped live acceptance must remain visibly incomplete',
    )
  }
  const output = {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    mode: 'self-test',
    defaultModeUsesDatabase: false,
    defaultModeUsesNetwork: false,
    testedModes: results.map((result) => result.mode),
    oauthCalls: results.reduce(
      (sum, result) => sum + result.networkCalls.token,
      0,
    ),
    shopFlowCalls: results.reduce(
      (sum, result) => sum + result.networkCalls.shop,
      0,
    ),
    providerMutationCount: 0,
    forbiddenProviderMutationEndpointBlocked: forbiddenBlocked,
    allSkippedLiveAcceptanceBlocked: true,
    persistentFixturesCreated: 0,
  }
  if (JSON.stringify(output).includes(clientSecretCanary)) {
    fail(
      'ACCEPTANCE_SELF_TEST_FAILED',
      'Self-test output contains protected credential material',
    )
  }
  return output
}

function plan() {
  return {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    mode: 'plan',
    defaultModeUsesDatabase: false,
    defaultModeUsesNetwork: false,
    executionRequiresConfirmation: EXECUTION_CONFIRMATION,
    target: {
      organization: TARGET_ORGANIZATION_NAME,
      warehouseGlobalId: TARGET_WAREHOUSE_GLOBAL_ID,
      warehouseCode: TARGET_WAREHOUSE_CODE,
      provider: PROVIDER,
      environment: ENVIRONMENT,
    },
    attemptedFlowsOnExecute: ['small_parcel_shopFlow', 'ltl_shopFlow'],
    providerMutationsPlanned: 0,
    databaseMutationsPlanned: 0,
    persistentFixturesPlanned: 0,
  }
}

function parsedArguments(argv) {
  const known = new Set(['--self-test', '--execute'])
  const unknown = argv.find(
    (argument) => !known.has(argument) && !argument.startsWith('--confirm='),
  )
  if (unknown) {
    fail('ACCEPTANCE_ARGUMENT_INVALID', 'An unsupported argument was supplied')
  }
  const selfTestRequested = argv.includes('--self-test')
  const executeRequested = argv.includes('--execute')
  if (selfTestRequested && executeRequested) {
    fail(
      'ACCEPTANCE_ARGUMENT_INVALID',
      'Self-test and live execution are mutually exclusive',
    )
  }
  return {
    selfTestRequested,
    executeRequested,
    confirmation: argv.find((argument) => argument.startsWith('--confirm='))
      ?.slice('--confirm='.length) || '',
  }
}

function safeTopLevelError(error) {
  if (error instanceof AcceptanceError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'ACCEPTANCE_FAILED',
    message: 'The Worldwide Express sandbox acceptance could not be completed',
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parsedArguments(argv)
    let result
    if (args.selfTestRequested) {
      result = await selfTest()
    } else if (args.executeRequested) {
      if (args.confirmation !== EXECUTION_CONFIRMATION) {
        fail(
          'ACCEPTANCE_CONFIRMATION_REQUIRED',
          `Execution requires --confirm=${EXECUTION_CONFIRMATION}`,
        )
      }
      result = await executeAcceptance()
    } else {
      result = plan()
    }
    console.log(JSON.stringify(result, null, 2))
    if (result.ok !== true) process.exitCode = 1
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      scriptVersion: SCRIPT_VERSION,
      mode: argv.includes('--execute') ? 'execute' : 'validation',
      ...safeTopLevelError(error),
      providerMutationCount: 0,
      databaseMutationCount: 0,
      persistentFixturesCreated: 0,
    }, null, 2))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
