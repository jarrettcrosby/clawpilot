#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { globalIdPattern } from '../app_src/lib/globalIds.mjs'

export const SCRIPT_VERSION = 'ag-alchemy-carrier-sandbox-rating-proof-v1'
export const EXECUTION_CONFIRMATION =
  'prove-ag-alchemy-carrier-sandbox-rating-v1'
export const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
export const TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
export const TRUSTED_PUBLIC_ORIGIN = 'https://dev.aiapp.eigenracing.com'
export const TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'
export const TARGET_WAREHOUSE_GLOBAL_ID = 'gwh5366613'
export const TARGET_WAREHOUSE_CODE = 'AG-ALCHEMY-01'
export const MANAGED_BY = 'ag-alchemy-episcs-sandbox-rating-delegation'
export const EXPECTED_PROVIDERS = Object.freeze(['fedex_rest', 'ups_rest'])

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RATE_EVIDENCE_PATTERN = globalIdPattern('grq')
const SESSION_COOKIE_NAMES = new Set([
  '__Host-clawpilot_session',
  'clawpilot_session',
])
const ALLOWED_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/session',
  '/api/auth/workspace',
  '/api/integrations/carriers',
])
const MAX_RESPONSE_BYTES = 1024 * 1024
const SAFE_DESTINATION = Object.freeze({
  name: 'John Doe',
  line1: '101 Academy Drive',
  line2: null,
  city: 'Buzzards Bay',
  region: 'MA',
  postalCode: '02532',
  countryCode: 'US',
})
const SIDE_EFFECT_COUNT_FIELDS = Object.freeze([
  'rateTestLabels',
  'rateTestLabelAttempts',
  'labels',
  'labelAttempts',
  'shipments',
  'printArtifacts',
  'printJobs',
])

const TARGET_WAREHOUSE_SQL = `
  SELECT
    organization.id::text AS organization_id,
    organization.name AS organization_name,
    warehouse.global_id AS warehouse_global_id,
    warehouse.code AS warehouse_code,
    warehouse.name AS warehouse_name,
    warehouse.address AS warehouse_address,
    warehouse.status AS warehouse_status,
    (
      SELECT count(*)::integer
      FROM operations_warehouses active_warehouse
      WHERE active_warehouse.organization_id = organization.id
        AND active_warehouse.status = 'active'
    ) AS active_warehouse_count
  FROM workspace_organizations organization
  JOIN operations_warehouses warehouse
    ON warehouse.organization_id = organization.id
   AND warehouse.global_id = $2
  WHERE organization.id = $1::uuid
`

const TARGET_CARRIER_ACCOUNTS_SQL = `
  SELECT
    integration.id::text AS integration_account_id,
    integration.global_id AS integration_global_id,
    integration.provider,
    integration.environment,
    integration.status AS integration_status,
    integration.configuration,
    credential.verification_status,
    carrier_account.global_id AS carrier_account_global_id,
    carrier_account.status AS carrier_account_status,
    carrier_account.sender_name,
    carrier_account.registered_address,
    carrier_account.registered_address_fingerprint,
    carrier_account.allow_sender_billing,
    carrier_account.allow_recipient_billing,
    carrier_account.allow_third_party_billing
  FROM operations_integration_accounts integration
  JOIN operations_carrier_credentials credential
    ON credential.organization_id = integration.organization_id
   AND credential.integration_account_id = integration.id
  LEFT JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = integration.organization_id
   AND carrier_account.integration_account_id = integration.id
  WHERE integration.organization_id = $1::uuid
    AND integration.integration_type = 'carrier'
    AND integration.environment = 'sandbox'
    AND integration.provider = ANY($2::text[])
  ORDER BY integration.provider, carrier_account.global_id
`

const COUNT_SNAPSHOT_SQL = `
  SELECT
    clock_timestamp() AS captured_at,
    (
      SELECT count(*)::integer
      FROM operations_carrier_rate_requests
      WHERE organization_id = $1::uuid
    ) AS rate_requests,
    (
      SELECT count(*)::integer
      FROM operations_carrier_rate_test_labels
      WHERE organization_id = $1::uuid
    ) AS rate_test_labels,
    (
      SELECT count(*)::integer
      FROM operations_carrier_rate_test_label_attempts
      WHERE organization_id = $1::uuid
    ) AS rate_test_label_attempts,
    (
      SELECT count(*)::integer
      FROM operations_labels
      WHERE organization_id = $1::uuid
    ) AS labels,
    (
      SELECT count(*)::integer
      FROM operations_label_attempts
      WHERE organization_id = $1::uuid
    ) AS label_attempts,
    (
      SELECT count(*)::integer
      FROM operations_shipments
      WHERE organization_id = $1::uuid
    ) AS shipments,
    (
      SELECT count(*)::integer
      FROM operations_print_artifacts
      WHERE organization_id = $1::uuid
    ) AS print_artifacts,
    (
      SELECT count(*)::integer
      FROM operations_print_jobs
      WHERE organization_id = $1::uuid
    ) AS print_jobs
`

const NEW_RATE_EVIDENCE_SQL = `
  SELECT
    rate.global_id,
    rate.provider,
    rate.environment,
    rate.purpose,
    rate.status,
    rate.error_code,
    rate.billing_relationship,
    carrier_account.global_id AS carrier_account_global_id,
    CASE
      WHEN jsonb_typeof(rate.redacted_response->'rates') = 'array'
      THEN jsonb_array_length(rate.redacted_response->'rates')
      ELSE 0
    END AS rate_count,
    CASE
      WHEN jsonb_typeof(rate.redacted_response->'rates') = 'array'
      THEN (
        jsonb_array_length(rate.redacted_response->'rates') > 0
        AND COALESCE(
          (rate.redacted_response->>'rateCount')::integer,
          -1
        ) = jsonb_array_length(rate.redacted_response->'rates')
      )
      ELSE false
    END AS response_valid
  FROM operations_carrier_rate_requests rate
  JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = rate.organization_id
   AND carrier_account.id = rate.carrier_account_id
  WHERE rate.organization_id = $1::uuid
    AND rate.created_at >= $2::timestamptz
  ORDER BY rate.provider, rate.global_id
`

const RELEVANT_AUDIT_SQL = `
  SELECT
    event_type,
    payload->>'provider' AS provider,
    payload->>'evidenceGlobalId' AS evidence_global_id
  FROM audit_events
  WHERE organization_id = $1::uuid
    AND created_at >= $2::timestamptz
    AND (
      event_type IN (
        'carrier.sandbox_rate.succeeded',
        'carrier.sandbox_rate.failed'
      )
      OR event_type LIKE 'carrier.rate_test_label.%'
    )
  ORDER BY created_at, id
`

class ProofError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProofError'
    this.code = code
  }
}

function fail(code, message) {
  throw new ProofError(code, message)
}

function environmentValue(name) {
  return String(process.env[name] || '').trim()
}

function requiredEnvironmentValue(name, minimum = 1) {
  const value = environmentValue(name)
  if (value.length < minimum) {
    fail('PROOF_CONFIGURATION_INVALID', `${name} is required for execution`)
  }
  return value
}

function requireTrustedDevelopmentEnvironment() {
  if (
    environmentValue('RAILWAY_PROJECT_ID') !== TRUSTED_RAILWAY_PROJECT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_ID')
      !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_NAME') !== 'development'
  ) {
    fail(
      'PROOF_ENVIRONMENT_FORBIDDEN',
      'Execution is restricted to the trusted ClawPilot Railway development environment',
    )
  }
}

function normalizedCarrierAddress(value) {
  const source = value && typeof value === 'object' ? value : {}
  const normalized = {
    line1: String(source.line1 || '').trim(),
    line2: String(source.line2 || '').trim() || null,
    city: String(source.city || '').trim(),
    region: String(source.region || '').trim().toUpperCase(),
    postalCode: String(source.postalCode || '').trim(),
    countryCode: String(
      source.countryCode || source.country || '',
    ).trim().toUpperCase(),
  }
  if (
    !normalized.line1
    || !normalized.city
    || !normalized.region
    || !normalized.postalCode
    || !/^[A-Z]{2}$/.test(normalized.countryCode)
  ) {
    fail(
      'PROOF_TARGET_WAREHOUSE_INVALID',
      'AG Alchemy warehouse address is invalid',
    )
  }
  return normalized
}

function carrierAddressFingerprint(value) {
  const address = normalizedCarrierAddress(value)
  return createHash('sha256')
    .update(JSON.stringify({
      line1: address.line1.toLowerCase(),
      line2: address.line2?.toLowerCase() || null,
      city: address.city.toLowerCase(),
      region: address.region.toLowerCase(),
      postalCode: address.postalCode
        .toLowerCase()
        .replace(/[\s-]/g, ''),
      countryCode: address.countryCode,
    }))
    .digest('hex')
}

function trustedPublicUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('PROOF_PUBLIC_URL_INVALID', 'CLAWPILOT_PUBLIC_URL is invalid')
  }
  if (
    url.protocol !== 'https:'
    || url.origin !== TRUSTED_PUBLIC_ORIGIN
    || (url.pathname !== '/' && url.pathname !== '')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    fail(
      'PROOF_PUBLIC_URL_INVALID',
      'CLAWPILOT_PUBLIC_URL must be the trusted HTTPS development origin',
    )
  }
  return new URL(`${url.origin}/`)
}

function postgresConnectionString(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('PROOF_DATABASE_URL_INVALID', 'DATABASE_URL is invalid')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('PROOF_DATABASE_URL_INVALID', 'DATABASE_URL must use PostgreSQL')
  }
  url.searchParams.delete('sslmode')
  return url.toString()
}

function loadExecutionConfiguration() {
  requireTrustedDevelopmentEnvironment()
  const loginEmail = requiredEnvironmentValue('APP_LOGIN_EMAIL', 3)
    .toLowerCase()
  if (!/^[^@\s]+@[^@\s]+$/.test(loginEmail)) {
    fail('PROOF_LOGIN_EMAIL_INVALID', 'APP_LOGIN_EMAIL is invalid')
  }
  return {
    publicUrl: trustedPublicUrl(
      requiredEnvironmentValue('CLAWPILOT_PUBLIC_URL', 8),
    ),
    loginEmail,
    loginPassword: requiredEnvironmentValue('APP_LOGIN_PASSWORD', 1),
    operatorSecret: requiredEnvironmentValue(
      'PIPELINE_OUTBOX_WORKER_SECRET',
      32,
    ),
    databaseUrl: postgresConnectionString(
      requiredEnvironmentValue('DATABASE_URL', 8),
    ),
  }
}

function splitSetCookieHeader(value) {
  if (!value) return []
  return value.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/)
}

function responseSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') {
    return headers.getSetCookie()
  }
  return splitSetCookieHeader(headers?.get?.('set-cookie') || '')
}

export class SessionCookieJar {
  #cookies = new Map()

  absorb(headers) {
    for (const serialized of responseSetCookies(headers)) {
      const firstPart = String(serialized).split(';', 1)[0]
      const separator = firstPart.indexOf('=')
      if (separator <= 0) continue
      const name = firstPart.slice(0, separator).trim()
      if (!SESSION_COOKIE_NAMES.has(name)) continue
      const value = firstPart.slice(separator + 1).trim()
      if (
        !value
        || /(?:^|;)\s*max-age=0(?:;|$)/i.test(String(serialized))
      ) {
        this.#cookies.delete(name)
      } else {
        this.#cookies.set(name, value)
      }
    }
  }

  hasSession() {
    return this.#cookies.size === 1
  }

  header() {
    if (!this.hasSession()) {
      fail('PROOF_SESSION_COOKIE_MISSING', 'Authenticated session cookie is missing')
    }
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }

  clear() {
    this.#cookies.clear()
  }
}

function safeHttpCode(payload) {
  const code = String(payload?.code || '').trim()
  return /^[A-Z0-9_]{2,100}$/.test(code) ? code : 'HTTP_REQUEST_FAILED'
}

async function requestJson(configuration, input) {
  const url = new URL(input.path, configuration.publicUrl)
  if (
    url.origin !== configuration.publicUrl.origin
    || !ALLOWED_API_PATHS.has(url.pathname)
    || url.search
    || url.hash
  ) {
    fail('PROOF_HTTP_TARGET_INVALID', 'Proof HTTP target is invalid')
  }
  const headers = {
    Accept: 'application/json',
    'User-Agent': `${SCRIPT_VERSION}`,
    ...(input.headers || {}),
  }
  if (input.cookieJar && input.sendCookie !== false) {
    headers.Cookie = input.cookieJar.header()
  }
  const response = await fetch(url, {
    method: input.method || 'GET',
    headers,
    body: input.body === undefined
      ? undefined
      : JSON.stringify(input.body),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  input.cookieJar?.absorb(response.headers)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (
    Number.isFinite(contentLength)
    && contentLength > MAX_RESPONSE_BYTES
  ) {
    fail('PROOF_HTTP_RESPONSE_TOO_LARGE', 'Proof HTTP response is too large')
  }
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    fail('PROOF_HTTP_RESPONSE_TOO_LARGE', 'Proof HTTP response is too large')
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    fail('PROOF_HTTP_RESPONSE_INVALID', 'Proof HTTP response is invalid')
  }
  if (!response.ok || payload?.ok === false) {
    const providerCode = safeHttpCode(payload)
    fail(
      providerCode,
      `Proof HTTP request failed safely with status ${response.status}`,
    )
  }
  return payload
}

async function login(configuration, cookieJar) {
  await requestJson(configuration, {
    path: '/api/auth/login',
    method: 'POST',
    cookieJar,
    sendCookie: false,
    headers: {
      'Content-Type': 'application/json',
      'x-clawpilot-operator-secret': configuration.operatorSecret,
    },
    body: { password: configuration.loginPassword },
  }).then((payload) => {
    if (payload?.ok !== true || !cookieJar.hasSession()) {
      fail('PROOF_LOGIN_FAILED', 'ClawPilot login failed')
    }
  })
}

async function readSession(configuration, cookieJar) {
  return requestJson(configuration, {
    path: '/api/auth/session',
    cookieJar,
  })
}

function assertLoginIdentity(session, loginEmail) {
  const authenticated = String(
    session?.authenticatedUser?.email || '',
  ).trim().toLowerCase()
  const effective = String(
    session?.effectiveUser?.email || '',
  ).trim().toLowerCase()
  if (
    session?.ok !== true
    || authenticated !== loginEmail
    || effective !== loginEmail
    || session?.impersonation?.active === true
  ) {
    fail(
      'PROOF_LOGIN_IDENTITY_MISMATCH',
      'Authenticated ClawPilot identity does not match APP_LOGIN_EMAIL',
    )
  }
}

async function selectTargetWorkspace(configuration, cookieJar) {
  let session = await readSession(configuration, cookieJar)
  assertLoginIdentity(session, configuration.loginEmail)
  const targets = Array.isArray(session.availableWorkspaces)
    ? session.availableWorkspaces.filter(
        (workspace) => workspace?.name === TARGET_ORGANIZATION_NAME,
      )
    : []
  if (targets.length !== 1 || !UUID_PATTERN.test(targets[0].organizationId)) {
    fail(
      'PROOF_TARGET_WORKSPACE_INVALID',
      'Expected exactly one target workspace membership',
    )
  }
  const target = targets[0]
  if (
    session?.activeWorkspace?.organizationId !== target.organizationId
  ) {
    const switched = await requestJson(configuration, {
      path: '/api/auth/workspace',
      method: 'POST',
      cookieJar,
      headers: { 'Content-Type': 'application/json' },
      body: {
        action: 'switch',
        organizationId: target.organizationId,
      },
    })
    if (
      switched?.activeWorkspace?.organizationId !== target.organizationId
      || switched?.activeWorkspace?.name !== TARGET_ORGANIZATION_NAME
    ) {
      fail('PROOF_WORKSPACE_SWITCH_FAILED', 'Target workspace switch failed')
    }
    /*
     * /api/auth/workspace rotates the durable session token. requestJson
     * absorbs Set-Cookie before this follow-up request.
     */
    session = await readSession(configuration, cookieJar)
    assertLoginIdentity(session, configuration.loginEmail)
  }
  if (
    session?.activeWorkspace?.organizationId !== target.organizationId
    || session?.activeWorkspace?.name !== TARGET_ORGANIZATION_NAME
    || !['owner', 'admin'].includes(session?.activeWorkspace?.role)
  ) {
    fail(
      'PROOF_TARGET_WORKSPACE_INACTIVE',
      'The target is not the exact active owner or admin workspace',
    )
  }
  return {
    organizationId: target.organizationId,
    role: session.activeWorkspace.role,
  }
}

async function logout(configuration, cookieJar) {
  if (!cookieJar.hasSession()) return
  await requestJson(configuration, {
    path: '/api/auth/logout',
    method: 'POST',
    cookieJar,
    headers: { 'Content-Type': 'application/json' },
    body: {},
  }).catch(() => undefined)
}

async function createPool(connectionString) {
  const requireFromApp = createRequire(
    new URL('../app_src/package.json', import.meta.url),
  )
  const { Pool } = requireFromApp('pg')
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
    max: 1,
  })
}

function exactManagedRatingConfiguration(configuration) {
  const exactRatingOnly = (
    configuration?.authorizationScope === 'sandbox_rating_only'
    && Array.isArray(configuration?.allowedCapabilities)
    && configuration.allowedCapabilities.length === 1
    && configuration.allowedCapabilities[0] === 'sandbox_rate'
  )
  const exactSandboxFulfillment = (
    configuration?.authorizationScope === 'sandbox_fulfillment_diagnostic'
    && Array.isArray(configuration?.allowedCapabilities)
    && configuration.allowedCapabilities.length === 2
    && configuration.allowedCapabilities[0] === 'sandbox_rate'
    && configuration.allowedCapabilities[1] === 'sandbox_label'
  )
  return (
    configuration?.managedBy === MANAGED_BY
    && configuration?.credentialRevealAllowed === false
    && configuration?.senderOriginWarehouseGlobalId
      === TARGET_WAREHOUSE_GLOBAL_ID
    && (exactRatingOnly || exactSandboxFulfillment)
  )
}

async function assertTrustedDatabase(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
       (
         SELECT value ->> 'id'
         FROM app_settings
         WHERE key = 'deployment.database.identity'
       ) AS database_fingerprint`,
  )
  if (
    result.rows[0]?.database_fingerprint
      !== TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT
  ) {
    fail(
      'PROOF_DATABASE_IDENTITY_MISMATCH',
      'Connected database is not the trusted ClawPilot development database',
    )
  }
}

async function loadDatabaseCarrierAccounts(client, organizationId) {
  const warehouseResult = await client.query(TARGET_WAREHOUSE_SQL, [
    organizationId,
    TARGET_WAREHOUSE_GLOBAL_ID,
  ])
  const warehouse = warehouseResult.rows[0]
  if (
    warehouseResult.rowCount !== 1
    || warehouse.organization_id !== organizationId
    || warehouse.organization_name !== TARGET_ORGANIZATION_NAME
    || warehouse.warehouse_global_id !== TARGET_WAREHOUSE_GLOBAL_ID
    || warehouse.warehouse_code !== TARGET_WAREHOUSE_CODE
    || warehouse.warehouse_status !== 'active'
    || Number(warehouse.active_warehouse_count) !== 1
  ) {
    fail(
      'PROOF_TARGET_WAREHOUSE_INVALID',
      'The target must have exactly the expected active warehouse',
    )
  }
  const warehouseAddress = normalizedCarrierAddress(
    warehouse.warehouse_address,
  )
  const warehouseAddressFingerprint = carrierAddressFingerprint(
    warehouseAddress,
  )
  const result = await client.query(TARGET_CARRIER_ACCOUNTS_SQL, [
    organizationId,
    EXPECTED_PROVIDERS,
  ])
  const resolved = new Map()
  for (const provider of EXPECTED_PROVIDERS) {
    const rows = result.rows.filter((row) => row.provider === provider)
    const integrationIds = new Set(
      rows.map((row) => row.integration_account_id),
    )
    const activeAccounts = rows.filter(
      (row) => row.carrier_account_status === 'active',
    )
    const integration = rows[0]
    const carrierAccount = activeAccounts[0]
    if (
      rows.length < 1
      || integrationIds.size !== 1
      || integration.environment !== 'sandbox'
      || integration.integration_status !== 'active'
      || integration.verification_status !== 'verified'
      || !exactManagedRatingConfiguration(integration.configuration)
      || activeAccounts.length !== 1
      || !globalIdPattern('gac').test(carrierAccount.carrier_account_global_id)
      || carrierAccount.sender_name !== warehouse.warehouse_name
      || JSON.stringify(normalizedCarrierAddress(
        carrierAccount.registered_address,
      )) !== JSON.stringify(warehouseAddress)
      || carrierAccount.registered_address_fingerprint
        !== warehouseAddressFingerprint
      || carrierAccount.allow_sender_billing !== true
      || carrierAccount.allow_recipient_billing !== false
      || carrierAccount.allow_third_party_billing !== false
    ) {
      fail(
        'PROOF_CARRIER_ACCOUNT_INVALID',
        `Target ${provider} rating account is invalid`,
      )
    }
    resolved.set(provider, {
      integrationGlobalId: integration.integration_global_id,
      carrierAccountGlobalId: carrierAccount.carrier_account_global_id,
    })
  }
  return resolved
}

async function resolveApiCarrierAccounts(
  configuration,
  cookieJar,
  organizationId,
  databaseAccounts,
) {
  const payload = await requestJson(configuration, {
    path: '/api/integrations/carriers',
    cookieJar,
  })
  if (
    payload?.ok !== true
    || payload?.canManage !== true
    || payload?.integrations?.organizationId !== organizationId
    || !Array.isArray(payload?.integrations?.accounts)
  ) {
    fail(
      'PROOF_CARRIER_STATE_INVALID',
      'ClawPilot carrier state is unavailable for the target workspace',
    )
  }
  const resolved = new Map()
  for (const provider of EXPECTED_PROVIDERS) {
    const connections = payload.integrations.accounts.filter(
      (account) => (
        account?.provider === provider
        && account?.environment === 'sandbox'
      ),
    )
    const connection = connections[0]
    const activeAccounts = Array.isArray(connection?.carrierAccounts)
      ? connection.carrierAccounts.filter(
          (account) => account?.status === 'active',
        )
      : []
    const carrierAccount = activeAccounts[0]
    const databaseAccount = databaseAccounts.get(provider)
    if (
      connections.length !== 1
      || connection.status !== 'active'
      || connection.verificationStatus !== 'verified'
      || !exactManagedRatingConfiguration(connection)
      || activeAccounts.length !== 1
      || carrierAccount.allowSenderBilling !== true
      || carrierAccount.allowRecipientBilling !== false
      || carrierAccount.allowThirdPartyBilling !== false
      || connection.globalId !== databaseAccount?.integrationGlobalId
      || carrierAccount.globalId
        !== databaseAccount?.carrierAccountGlobalId
    ) {
      fail(
        'PROOF_CARRIER_STATE_INVALID',
        `Target ${provider} API carrier state is invalid`,
      )
    }
    resolved.set(provider, {
      carrierAccountGlobalId: carrierAccount.globalId,
    })
  }
  return resolved
}

function countSnapshot(row) {
  const capturedAt = new Date(row.captured_at)
  if (!Number.isFinite(capturedAt.getTime())) {
    fail('PROOF_COUNT_SNAPSHOT_INVALID', 'Carrier proof timestamp is invalid')
  }
  return {
    capturedAt: capturedAt.toISOString(),
    rateRequests: Number(row.rate_requests),
    rateTestLabels: Number(row.rate_test_labels),
    rateTestLabelAttempts: Number(row.rate_test_label_attempts),
    labels: Number(row.labels),
    labelAttempts: Number(row.label_attempts),
    shipments: Number(row.shipments),
    printArtifacts: Number(row.print_artifacts),
    printJobs: Number(row.print_jobs),
  }
}

async function captureCounts(client, organizationId) {
  const result = await client.query(COUNT_SNAPSHOT_SQL, [organizationId])
  if (result.rowCount !== 1) {
    fail('PROOF_COUNT_SNAPSHOT_INVALID', 'Carrier proof count snapshot failed')
  }
  return countSnapshot(result.rows[0])
}

async function requestOneProviderRate(
  configuration,
  cookieJar,
  provider,
  carrierAccountGlobalId,
) {
  const payload = await requestJson(configuration, {
    path: '/api/integrations/carriers',
    method: 'PATCH',
    cookieJar,
    headers: { 'Content-Type': 'application/json' },
    body: {
      action: 'test-sandbox-rate',
      provider,
      environment: 'sandbox',
      carrierAccountGlobalId,
      destination: SAFE_DESTINATION,
    },
  })
  const rateTest = payload?.rateTest
  const rateCount = Array.isArray(rateTest?.rates)
    ? rateTest.rates.length
    : 0
  if (
    payload?.ok !== true
    || rateTest?.provider !== provider
    || rateTest?.environment !== 'sandbox'
    || rateTest?.carrierAccountGlobalId !== carrierAccountGlobalId
    || !RATE_EVIDENCE_PATTERN.test(String(rateTest?.evidenceGlobalId || ''))
    || rateCount < 1
  ) {
    fail(
      'PROOF_RATE_RESPONSE_INVALID',
      `ClawPilot returned invalid ${provider} sandbox-rate evidence`,
    )
  }
  return {
    provider,
    evidenceGlobalId: rateTest.evidenceGlobalId,
    rateCount,
    carrierAccountGlobalId,
  }
}

function unchangedSideEffects(before, after) {
  return Object.fromEntries(
    SIDE_EFFECT_COUNT_FIELDS.map((field) => [
      `${field}Unchanged`,
      before[field] === after[field],
    ]),
  )
}

async function assertPostconditions(
  client,
  organizationId,
  before,
  proofRates,
) {
  let after
  let rateResult
  let auditResult
  await client.query(
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  )
  try {
    after = await captureCounts(client, organizationId)
    rateResult = await client.query(NEW_RATE_EVIDENCE_SQL, [
      organizationId,
      before.capturedAt,
    ])
    auditResult = await client.query(RELEVANT_AUDIT_SQL, [
      organizationId,
      before.capturedAt,
    ])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
  const evidenceIds = proofRates
    .map((rate) => rate.evidenceGlobalId)
    .sort()
  const persistedIds = rateResult.rows
    .map((rate) => rate.global_id)
    .sort()
  const expectedProviderAccounts = new Map(
    proofRates.map((rate) => [
      rate.provider,
      rate.carrierAccountGlobalId,
    ]),
  )
  const onePerProvider = (
    rateResult.rowCount === EXPECTED_PROVIDERS.length
    && EXPECTED_PROVIDERS.every((provider) => (
      rateResult.rows.filter((row) => row.provider === provider).length === 1
    ))
  )
  const persistedRatesValid = rateResult.rows.every((row) => (
    row.environment === 'sandbox'
    && row.purpose === 'sandbox_rate_test'
    && row.status === 'succeeded'
    && row.error_code === null
    && row.billing_relationship === 'sender'
    && row.carrier_account_global_id
      === expectedProviderAccounts.get(row.provider)
    && Number(row.rate_count) > 0
    && row.response_valid === true
  ))
  const evidenceIdsMatch = (
    evidenceIds.length === persistedIds.length
    && evidenceIds.every((id, index) => id === persistedIds[index])
  )
  const successAudits = auditResult.rows.filter(
    (event) => event.event_type === 'carrier.sandbox_rate.succeeded',
  )
  const forbiddenAudits = auditResult.rows.filter(
    (event) => event.event_type !== 'carrier.sandbox_rate.succeeded',
  )
  const successAuditsMatch = (
    successAudits.length === EXPECTED_PROVIDERS.length
    && EXPECTED_PROVIDERS.every((provider) => {
      const expected = proofRates.find((rate) => rate.provider === provider)
      return successAudits.filter((event) => (
        event.provider === provider
        && event.evidence_global_id === expected?.evidenceGlobalId
      )).length === 1
    })
  )
  const sideEffects = unchangedSideEffects(before, after)
  const allSideEffectsUnchanged = Object.values(sideEffects).every(Boolean)
  const rateRequestsIncreasedByTwo = (
    after.rateRequests === before.rateRequests + EXPECTED_PROVIDERS.length
  )
  if (
    !onePerProvider
    || !persistedRatesValid
    || !evidenceIdsMatch
    || !successAuditsMatch
    || forbiddenAudits.length !== 0
    || !rateRequestsIncreasedByTwo
    || !allSideEffectsUnchanged
  ) {
    fail(
      'PROOF_POSTCONDITION_FAILED',
      'Carrier sandbox-rating proof postconditions failed',
    )
  }
  return {
    rateEvidenceRows: rateResult.rowCount,
    onePerProvider,
    persistedRatesValid,
    evidenceIdsMatch,
    successAuditCount: successAudits.length,
    successAuditsMatch,
    forbiddenAuditCount: forbiddenAudits.length,
    rateRequestsIncreasedByTwo,
    sideEffects,
    allSideEffectsUnchanged,
  }
}

export async function executeProof() {
  const configuration = loadExecutionConfiguration()
  const cookieJar = new SessionCookieJar()
  let pool = null
  let client = null
  let advisoryLockAcquired = false
  try {
    pool = await createPool(configuration.databaseUrl)
    client = await pool.connect()
    await assertTrustedDatabase(client)
    const lock = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [SCRIPT_VERSION],
    )
    advisoryLockAcquired = lock.rows[0]?.acquired === true
    if (!advisoryLockAcquired) {
      fail(
        'PROOF_ALREADY_RUNNING',
        'Another target carrier proof is already running',
      )
    }
    await login(configuration, cookieJar)
    const workspace = await selectTargetWorkspace(
      configuration,
      cookieJar,
    )
    const databaseAccounts = await loadDatabaseCarrierAccounts(
      client,
      workspace.organizationId,
    )
    const carrierAccounts = await resolveApiCarrierAccounts(
      configuration,
      cookieJar,
      workspace.organizationId,
      databaseAccounts,
    )
    const before = await captureCounts(client, workspace.organizationId)
    const proofRates = []
    for (const provider of EXPECTED_PROVIDERS) {
      proofRates.push(await requestOneProviderRate(
        configuration,
        cookieJar,
        provider,
        carrierAccounts.get(provider).carrierAccountGlobalId,
      ))
    }
    const assertions = await assertPostconditions(
      client,
      workspace.organizationId,
      before,
      proofRates,
    )
    return {
      ok: true,
      scriptVersion: SCRIPT_VERSION,
      mode: 'execute',
      target: {
        workspaceVerified: true,
        warehouseGlobalId: TARGET_WAREHOUSE_GLOBAL_ID,
      },
      rates: proofRates.map((rate) => ({
        provider: rate.provider,
        evidenceGlobalId: rate.evidenceGlobalId,
        rateCount: rate.rateCount,
      })),
      assertions,
      providerMutations: 0,
    }
  } finally {
    await logout(configuration, cookieJar)
    cookieJar.clear()
    if (client && advisoryLockAcquired) {
      await client.query(
        'SELECT pg_advisory_unlock(hashtext($1))',
        [SCRIPT_VERSION],
      ).catch(() => undefined)
    }
    client?.release()
    await pool?.end().catch(() => undefined)
    configuration.loginPassword = ''
    configuration.operatorSecret = ''
    configuration.databaseUrl = ''
  }
}

export function selfTest() {
  const jar = new SessionCookieJar()
  jar.absorb({
    getSetCookie: () => [
      '__Host-clawpilot_session=first-token; Path=/; HttpOnly; Secure',
    ],
  })
  if (!jar.hasSession() || !jar.header().includes('first-token')) {
    fail('PROOF_SELF_TEST_FAILED', 'Session cookie capture self-test failed')
  }
  jar.absorb({
    getSetCookie: () => [
      '__Host-clawpilot_session=rotated-token; Path=/; HttpOnly; Secure',
      'clawpilot_session=; Path=/; Max-Age=0; HttpOnly',
    ],
  })
  if (
    !jar.hasSession()
    || !jar.header().includes('rotated-token')
    || jar.header().includes('first-token')
  ) {
    fail('PROOF_SELF_TEST_FAILED', 'Session rotation self-test failed')
  }
  jar.clear()
  const safeRate = {
    provider: 'ups_rest',
    evidenceGlobalId: 'grq1234567',
    rateCount: 2,
  }
  const serialized = JSON.stringify(safeRate)
  if (
    serialized.includes(SAFE_DESTINATION.line1)
    || serialized.includes('amount')
    || !RATE_EVIDENCE_PATTERN.test(safeRate.evidenceGlobalId)
  ) {
    fail('PROOF_SELF_TEST_FAILED', 'Safe result self-test failed')
  }
  trustedPublicUrl(TRUSTED_PUBLIC_ORIGIN)
  return {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    mode: 'self-test',
    defaultModeUsesNetwork: false,
    defaultModeUsesDatabase: false,
    requiresExecuteFlag: true,
    requiresLiteralConfirmation: true,
    expectedProviders: [...EXPECTED_PROVIDERS],
    targetWarehouseGlobalId: TARGET_WAREHOUSE_GLOBAL_ID,
    safeOutputFields: ['provider', 'evidenceGlobalId', 'rateCount'],
  }
}

export function plan() {
  const checks = selfTest()
  return {
    ...checks,
    mode: 'plan',
    executionCommand: [
      'node',
      'scripts/prove-ag-alchemy-carrier-sandbox-rating.mjs',
      '--execute',
      `--confirm=${EXECUTION_CONFIRMATION}`,
    ].join(' '),
    networkCallsPlanned: [
      'ClawPilot login and session verification',
      'exact target workspace selection',
      'ClawPilot carrier-state read',
      'one UPS sandbox rating',
      'one FedEx sandbox rating',
      'ClawPilot logout',
    ],
    databaseWritesPlanned: [
      'two append-only sandbox-rate evidence rows',
      'two sandbox-rate success audit events',
      'short-lived authenticated session lifecycle',
    ],
    providerMutationsPlanned: 0,
    protectedOutput: [
      'credentials',
      'cookies',
      'raw provider responses',
      'address payloads',
      'rate amounts',
      'account numbers',
      'customer data',
    ],
  }
}

function parseArguments(argv) {
  const allowed = new Set(['--self-test', '--plan', '--execute'])
  const unknown = argv.find((value) => (
    !allowed.has(value) && !value.startsWith('--confirm=')
  ))
  if (unknown) {
    fail('PROOF_ARGUMENT_INVALID', 'Unsupported proof argument')
  }
  const selfTestOnly = argv.includes('--self-test')
  const explicitPlan = argv.includes('--plan')
  const execute = argv.includes('--execute')
  if (
    Number(selfTestOnly) + Number(explicitPlan) + Number(execute) > 1
  ) {
    fail('PROOF_ARGUMENT_INVALID', 'Choose one proof mode')
  }
  const confirmations = argv.filter((value) => value.startsWith('--confirm='))
  if (confirmations.length > 1) {
    fail('PROOF_ARGUMENT_INVALID', 'Only one confirmation is allowed')
  }
  const confirmation = confirmations[0]?.slice('--confirm='.length) || ''
  if (!execute && confirmation) {
    fail(
      'PROOF_CONFIRMATION_WITHOUT_EXECUTE',
      'Confirmation is accepted only with --execute',
    )
  }
  if (execute && confirmation !== EXECUTION_CONFIRMATION) {
    fail(
      'PROOF_CONFIRMATION_REQUIRED',
      `Execution requires --confirm=${EXECUTION_CONFIRMATION}`,
    )
  }
  return {
    mode: selfTestOnly ? 'self-test' : execute ? 'execute' : 'plan',
  }
}

function safeCliError(error) {
  if (error instanceof ProofError) {
    return { code: error.code, error: error.message }
  }
  return {
    code: 'PROOF_UNEXPECTED_FAILURE',
    error: 'Carrier sandbox-rating proof failed safely',
  }
}

function printSafe(value, stream = 'stdout') {
  const serialized = JSON.stringify(value, null, 2)
  if (stream === 'stderr') console.error(serialized)
  else console.log(serialized)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { mode } = parseArguments(process.argv.slice(2))
    const result = mode === 'self-test'
      ? selfTest()
      : mode === 'execute'
        ? await executeProof()
        : plan()
    printSafe(result)
  } catch (error) {
    printSafe({ ok: false, mode: 'safe-failure', ...safeCliError(error) }, 'stderr')
    process.exitCode = 1
  }
}
