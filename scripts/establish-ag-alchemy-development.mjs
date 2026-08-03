#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { globalIdPattern } from '../app_src/lib/globalIds.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

export const SCRIPT_VERSION = 'ag-alchemy-development-v1'
export const EXECUTION_CONFIRMATION =
  'establish-ag-alchemy-development-v1'
export const DISPOSABLE_REHEARSAL_CONFIRMATION =
  'establish-ag-alchemy-disposable-rehearsal-v1'
export const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
export const TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'
export const SHOPIFY_ADMIN_API_VERSION = '2026-07'
export const SHOPIFY_RESOURCES = Object.freeze([
  'fulfillments',
  'inventory',
  'orders',
  'products',
  'returns',
])
export const APPROVED_SHOPIFY_READ_SCOPES = Object.freeze([
  'read_all_orders',
  'read_inventory',
  'read_locations',
  'read_merchant_managed_fulfillment_orders',
  'read_orders',
  'read_products',
  'read_shipping',
])
export const ALLOWED_SOURCE_ATTEMPTS = Object.freeze([
  'connection.verify',
  'orders.held_preview.read',
])

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const EMAIL_PATTERN =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const SHOP_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/
const SHOP_ID_PATTERN = /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/
const OWNER_PERMISSIONS = Object.freeze({
  accessDemo: true,
  inviteUsers: true,
  manageUserAccess: true,
  createBoards: true,
  createPipelines: true,
  viewOperations: true,
  manageOperations: true,
  executeWarehouse: true,
  manageCarrierRateNetworks: true,
  grantCarrierRateAccess: true,
  viewCarrierCost: true,
  reconcileCarrierBilling: true,
  approveCarrierSettlement: true,
  viewFullReleaseHistory: true,
  manageBackups: true,
  manageLinks: true,
  viewAccounting: true,
  prepareAccounting: true,
  approveAccounting: true,
  viewOrganizationAudit: true,
  viewSystemAudit: true,
})

function fail(message) {
  throw new Error(message)
}

function normalizedText(value) {
  return String(value || '').trim()
}

function isLocalDatabaseUrl(value) {
  try {
    const database = new URL(normalizedText(value))
    return ['postgres:', 'postgresql:'].includes(database.protocol)
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        database.hostname.toLowerCase(),
      )
  } catch {
    return false
  }
}

function populatedRailwayMarkers(environment) {
  return Object.entries(environment)
    .filter(([key, value]) => (
      key.startsWith('RAILWAY_') && normalizedText(value)
    ))
    .map(([key]) => key)
}

function normalizedEmail(value, label) {
  const email = normalizedText(value).toLowerCase()
  if (
    !email
    || email.length > 254
    || !EMAIL_PATTERN.test(email)
    || !/^[\x21-\x7e]+$/.test(email)
  ) {
    fail(`${label} must be a valid ASCII email address`)
  }
  return email
}

function reference(value, prefix, label) {
  const normalized = normalizedText(value).toLowerCase()
  if (!globalIdPattern(prefix).test(normalized)) {
    fail(`${label} must be a ${prefix} Global ID`)
  }
  return normalized
}

function shopDomain(value) {
  const normalized = normalizedText(value).toLowerCase()
  if (!SHOP_DOMAIN_PATTERN.test(normalized)) {
    fail('AG_ALCHEMY_SHOP_DOMAIN must be a canonical myshopify.com domain')
  }
  return normalized
}

function shopExternalAccountId(value) {
  const normalized = normalizedText(value)
  if (!SHOP_ID_PATTERN.test(normalized)) {
    fail(
      'AG_ALCHEMY_SHOP_EXTERNAL_ACCOUNT_ID must be a Shopify Shop Global ID',
    )
  }
  return normalized
}

export function parseArguments(argv) {
  const flags = new Set(argv)
  const allowed = new Set(['--plan', '--execute', '--self-test', '--help'])
  const unknown = argv.filter((value) => !allowed.has(value))
  if (unknown.length) fail(`Unsupported argument(s): ${unknown.join(', ')}`)
  const selected = ['--plan', '--execute', '--self-test']
    .filter((flag) => flags.has(flag))
  if (selected.length > 1) {
    fail('--plan, --execute, and --self-test cannot be combined')
  }
  return {
    mode: flags.has('--execute')
      ? 'execute'
      : flags.has('--self-test')
        ? 'self-test'
        : 'plan',
    help: flags.has('--help'),
  }
}

export function configurationFromEnvironment(environment, mode = 'plan') {
  const targetName = normalizedText(
    environment.AG_ALCHEMY_TARGET_ORGANIZATION_NAME
      || TARGET_ORGANIZATION_NAME,
  ).replace(/\s+/g, ' ')
  if (targetName !== TARGET_ORGANIZATION_NAME) {
    fail(
      `AG_ALCHEMY_TARGET_ORGANIZATION_NAME must be exactly ${TARGET_ORGANIZATION_NAME}`,
    )
  }
  const config = {
    actorEmail: normalizedEmail(
      environment.AG_ALCHEMY_ACTOR_EMAIL,
      'AG_ALCHEMY_ACTOR_EMAIL',
    ),
    sourceOrganizationReference: reference(
      environment.AG_ALCHEMY_SOURCE_ORGANIZATION_REFERENCE,
      'ga',
      'AG_ALCHEMY_SOURCE_ORGANIZATION_REFERENCE',
    ),
    sourceAccountGlobalId: reference(
      environment.AG_ALCHEMY_SOURCE_ACCOUNT_GLOBAL_ID,
      'gia',
      'AG_ALCHEMY_SOURCE_ACCOUNT_GLOBAL_ID',
    ),
    retainedDefaultOrganizationReference: reference(
      environment.AG_ALCHEMY_RETAIN_DEFAULT_ORGANIZATION_REFERENCE,
      'ga',
      'AG_ALCHEMY_RETAIN_DEFAULT_ORGANIZATION_REFERENCE',
    ),
    targetName,
    shopDomain: shopDomain(environment.AG_ALCHEMY_SHOP_DOMAIN),
    shopExternalAccountId: shopExternalAccountId(
      environment.AG_ALCHEMY_SHOP_EXTERNAL_ACCOUNT_ID,
    ),
    expectedDatabaseFingerprint: normalizedText(
      environment.AG_ALCHEMY_DATABASE_FINGERPRINT,
    ).toLowerCase(),
    expectedPlanDigest: normalizedText(
      environment.AG_ALCHEMY_PLAN_DIGEST,
    ).toLowerCase(),
    confirmation: normalizedText(environment.AG_ALCHEMY_CONFIRM),
  }
  if (
    mode === 'execute'
    && !UUID_PATTERN.test(config.expectedDatabaseFingerprint)
  ) {
    fail(
      'AG_ALCHEMY_DATABASE_FINGERPRINT must be the exact development database identity',
    )
  }
  if (mode === 'execute' && !SHA256_PATTERN.test(config.expectedPlanDigest)) {
    fail(
      'AG_ALCHEMY_PLAN_DIGEST must be the SHA-256 digest from the immediately prior plan',
    )
  }
  if (
    mode === 'execute'
    && config.confirmation !== EXECUTION_CONFIRMATION
  ) {
    fail(`AG_ALCHEMY_CONFIRM=${EXECUTION_CONFIRMATION} is required`)
  }
  return config
}

export function validateRuntimeEnvironment(
  environment,
  config,
  mode = 'plan',
) {
  if (normalizedText(environment.CLAWPILOT_STORAGE).toLowerCase() !== 'postgres') {
    fail('CLAWPILOT_STORAGE=postgres is required')
  }
  const databaseUrl = normalizedText(environment.DATABASE_URL)
  if (!databaseUrl) fail('DATABASE_URL is required')
  const rehearsalConfirmation = normalizedText(
    environment.AG_ALCHEMY_DISPOSABLE_REHEARSAL_CONFIRM,
  )
  if (rehearsalConfirmation) {
    if (rehearsalConfirmation !== DISPOSABLE_REHEARSAL_CONFIRMATION) {
      fail(
        `AG_ALCHEMY_DISPOSABLE_REHEARSAL_CONFIRM=`
        + `${DISPOSABLE_REHEARSAL_CONFIRMATION} is required`,
      )
    }
    const railwayMarkers = populatedRailwayMarkers(environment)
    if (railwayMarkers.length > 0) {
      fail(
        'Disposable rehearsal cannot run with Railway environment markers',
      )
    }
    if (!isLocalDatabaseUrl(databaseUrl)) {
      fail('Disposable rehearsal requires a local PostgreSQL database URL')
    }
  } else {
    if (
      normalizedText(environment.RAILWAY_ENVIRONMENT_NAME).toLowerCase()
        !== 'development'
    ) {
      fail('RAILWAY_ENVIRONMENT_NAME=development is required')
    }
    if (
      normalizedText(environment.RAILWAY_PROJECT_ID).toLowerCase()
        !== TRUSTED_RAILWAY_PROJECT_ID
    ) {
      fail('RAILWAY_PROJECT_ID does not match the trusted ClawPilot project')
    }
    if (
      normalizedText(environment.RAILWAY_ENVIRONMENT_ID).toLowerCase()
        !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
    ) {
      fail(
        'RAILWAY_ENVIRONMENT_ID does not match the trusted development environment',
      )
    }
  }
  for (const key of ['VERCEL_ENV', 'CLAWPILOT_ENV']) {
    const value = normalizedText(environment[key]).toLowerCase()
    if (value && !['dev', 'development', 'preview', 'local'].includes(value)) {
      fail(`${key}=${environment[key]} is not a development environment`)
    }
  }
  const configuredOwner = normalizedEmail(
    environment.APP_LOGIN_EMAIL,
    'APP_LOGIN_EMAIL',
  )
  if (configuredOwner !== config.actorEmail) {
    fail('AG_ALCHEMY_ACTOR_EMAIL must match the configured root application owner')
  }
  if (mode === 'execute') {
    commerceEncryptionKey(environment)
  }
}

export function commerceEncryptionKey(environment) {
  const dedicated = String(
    environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
      || environment.AGENT_CREDENTIAL_ENCRYPTION_KEY
      || '',
  )
  if (dedicated.length < 32) {
    fail(
      'A hosted commerce credential encryption key of at least 32 characters is required',
    )
  }
  return crypto.createHash('sha256').update(dedicated).digest()
}

export function commerceCredentialAuthenticatedData(input) {
  const organizationId = normalizedText(input.organizationId).toLowerCase()
  if (!UUID_PATTERN.test(organizationId)) {
    fail('A valid commerce organization is required')
  }
  if (input.provider !== 'shopify') {
    fail('This development correction supports only Shopify')
  }
  if (input.environment !== 'sandbox') {
    fail('This development correction supports only a Shopify sandbox account')
  }
  const externalAccountId = shopExternalAccountId(input.externalAccountId)
  return Buffer.from(
    `clawpilot:commerce:${organizationId}:shopify:sandbox:${externalAccountId}:credential:v1`,
    'utf8',
  )
}

function normalizedShopifyCredential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Stored Shopify credential payload is invalid')
  }
  const keys = Object.keys(value).sort()
  assert.deepEqual(
    keys,
    ['authMode', 'clientId', 'clientSecret', 'provider'],
    'Stored Shopify credential contains unsupported fields',
  )
  if (
    value.provider !== 'shopify'
    || value.authMode !== 'shopify_client_credentials'
  ) {
    fail('Stored credential is not a Shopify client-credentials payload')
  }
  const clientId = normalizedText(value.clientId)
  const clientSecret = normalizedText(value.clientSecret)
  if (
    clientId.length < 8
    || clientId.length > 255
    || !/^[\x21-\x7e]+$/.test(clientId)
  ) {
    fail('Stored Shopify client ID is invalid')
  }
  if (
    clientSecret.length < 16
    || clientSecret.length > 4096
    || !/^[\x21-\x7e]+$/.test(clientSecret)
  ) {
    fail('Stored Shopify client secret is invalid')
  }
  return {
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    clientId,
    clientSecret,
  }
}

export function decryptShopifyCredential(input) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    input.key,
    input.encrypted.iv,
  )
  decipher.setAAD(commerceCredentialAuthenticatedData(input))
  decipher.setAuthTag(input.encrypted.tag)
  let plaintext
  try {
    plaintext = Buffer.concat([
      decipher.update(input.encrypted.ciphertext),
      decipher.final(),
    ])
    return normalizedShopifyCredential(
      JSON.parse(plaintext.toString('utf8')),
    )
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message.startsWith('Stored Shopify')
        || error.message.includes('unsupported fields')
      )
    ) {
      throw error
    }
    fail('Stored Shopify credential could not be decrypted')
  } finally {
    plaintext?.fill(0)
  }
}

export function encryptShopifyCredential(input) {
  const credential = normalizedShopifyCredential(input.credential)
  const iv = input.iv ? Buffer.from(input.iv) : crypto.randomBytes(12)
  if (iv.length !== 12) fail('Commerce credential IV must contain 12 bytes')
  const cipher = crypto.createCipheriv('aes-256-gcm', input.key, iv)
  cipher.setAAD(commerceCredentialAuthenticatedData(input))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final(),
  ])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

async function boundedJsonResponse(response, maximum) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maximum) {
    fail('Shopify read-only verification response exceeded the safe size limit')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  try {
    if (bytes.length > maximum) {
      fail('Shopify read-only verification response exceeded the safe size limit')
    }
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('Shopify read-only verification returned an invalid response')
    }
    return parsed
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('Shopify read-only verification')
    ) {
      throw error
    }
    fail('Shopify read-only verification returned an invalid response')
  } finally {
    bytes.fill(0)
  }
}

function verifiedScopes(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/).filter(Boolean)
      : []
  const scopes = new Set()
  for (const item of values) {
    const scope = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? item.handle
        : null
    if (
      typeof scope !== 'string'
      || !/^[a-z][a-z0-9_]{0,127}$/.test(scope)
    ) {
      fail('Shopify read-only verification returned invalid scope evidence')
    }
    scopes.add(scope)
  }
  return [...scopes].sort()
}

function approvedReadOnlyShopifyScopes(value, label) {
  const grantedScopes = verifiedScopes(value)
  const prohibited = grantedScopes.filter(
    (scope) => scope.startsWith('write_'),
  )
  if (prohibited.length) {
    fail(`${label} includes prohibited Shopify write scope(s): ${
      prohibited.join(', ')
    }`)
  }
  const missing = APPROVED_SHOPIFY_READ_SCOPES.filter(
    (scope) => !grantedScopes.includes(scope),
  )
  if (missing.length) {
    fail(`${label} is missing approved Shopify read scope(s): ${
      missing.join(', ')
    }`)
  }
  return grantedScopes
}

const SHOPIFY_READ_ONLY_PROBE = `query ClawPilotShopifyConnectionProbe {
  shop {
    id
    myshopifyDomain
    name
  }
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}`

export async function probeShopifyReadOnly(
  input,
  options = {},
) {
  const domain = shopDomain(input.shopDomain)
  const credential = normalizedShopifyCredential(input.credential)
  const fetchImpl = options.fetchImpl || fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  let accessToken = ''
  try {
    const tokenResponse = await fetchImpl(
      `https://${domain}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: credential.clientId,
          client_secret: credential.clientSecret,
        }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      },
    )
    const tokenPayload = await boundedJsonResponse(
      tokenResponse,
      64 * 1024,
    )
    if (!tokenResponse.ok) {
      fail('Shopify rejected the configured client credentials')
    }
    accessToken = normalizedText(tokenPayload.access_token)
    const expiresIn = Number(tokenPayload.expires_in)
    if (
      accessToken.length < 8
      || accessToken.length > 4096
      || !/^[\x21-\x7e]+$/.test(accessToken)
      || !Number.isInteger(expiresIn)
      || expiresIn < 60
      || expiresIn > 86_400
    ) {
      fail('Shopify read-only verification returned an invalid token grant')
    }
    const tokenGrantedScopes = approvedReadOnlyShopifyScopes(
      tokenPayload.scope,
      'Shopify token grant',
    )
    const graphqlResponse = await fetchImpl(
      `https://${domain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({
          query: SHOPIFY_READ_ONLY_PROBE,
          variables: {},
          operationName: 'ClawPilotShopifyConnectionProbe',
        }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      },
    )
    const graphqlPayload = await boundedJsonResponse(
      graphqlResponse,
      4 * 1024 * 1024,
    )
    if (
      !graphqlResponse.ok
      || (Array.isArray(graphqlPayload.errors)
        && graphqlPayload.errors.length)
    ) {
      fail('Shopify rejected the read-only identity and scope query')
    }
    const shop = graphqlPayload.data?.shop
    const installation = graphqlPayload.data?.currentAppInstallation
    const verifiedDomain = shopDomain(shop?.myshopifyDomain)
    const verifiedExternalAccountId = shopExternalAccountId(shop?.id)
    const shopName = normalizedText(shop?.name)
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (
      !installation
      || verifiedDomain !== domain
      || verifiedExternalAccountId !== input.externalAccountId
      || !shopName
      || shopName.length > 255
    ) {
      fail('Shopify returned a different or invalid store identity')
    }
    const grantedScopes = approvedReadOnlyShopifyScopes(
      installation.accessScopes,
      'Shopify connection probe',
    )
    return {
      providerAccountId: verifiedExternalAccountId,
      shopDomain: verifiedDomain,
      shopName,
      apiVersion: SHOPIFY_ADMIN_API_VERSION,
      grantedScopes,
      tokenGrantedScopes,
      requestedScopes: [...APPROVED_SHOPIFY_READ_SCOPES],
      missingScopes: [],
      expiresIn,
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('Shopify')
    ) {
      throw error
    }
    if (error instanceof Error && error.name === 'AbortError') {
      fail('Shopify read-only verification timed out')
    }
    fail('Shopify read-only verification failed')
  } finally {
    clearTimeout(timeout)
    accessToken = ''
    credential.clientId = ''
    credential.clientSecret = ''
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  }
  return value
}

export function planDigest(plan) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalValue(plan)))
    .digest('hex')
}

function numberValue(value) {
  const parsed = Number(value || 0)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail('Development correction encountered an invalid database count')
  }
  return parsed
}

function stableConfiguration(configuration) {
  const value = configuration && typeof configuration === 'object'
    && !Array.isArray(configuration)
    ? configuration
    : {}
  return {
    accountName: value.accountName || null,
    accessTokenPersisted: value.accessTokenPersisted === true,
    adapterVersion: value.adapterVersion || null,
    apiVersion: value.apiVersion || null,
    authMode: value.authMode || null,
    classification: value.classification || null,
    domainWorkersActivated: value.domainWorkersActivated === true,
    grantedScopes: Array.isArray(value.grantedScopes)
      ? [...value.grantedScopes].sort()
      : [],
    missingScopes: Array.isArray(value.missingScopes)
      ? [...value.missingScopes].sort()
      : [],
    providerAccountId: value.providerAccountId || null,
    requestedScopes: Array.isArray(value.requestedScopes)
      ? [...value.requestedScopes].sort()
      : [],
    restrictedScopes: Array.isArray(value.restrictedScopes)
      ? [...value.restrictedScopes].sort()
      : [],
    shopDomain: value.shopDomain || null,
    tokenGrantedScopes: Array.isArray(value.tokenGrantedScopes)
      ? [...value.tokenGrantedScopes].sort()
      : [],
    webhookSecretVerified: value.webhookSecretVerified === true,
  }
}

function sourceAccountSummary(row) {
  return {
    id: row.id,
    globalId: row.global_id,
    organizationId: row.organization_id,
    provider: row.provider,
    integrationType: row.integration_type,
    environment: row.environment,
    externalAccountId: row.external_account_id,
    displayName: row.display_name,
    status: row.status,
    configuration: stableConfiguration(row.configuration),
    credentialGeneration: row.commerce_credential_generation,
    credentialReferencePresent: Boolean(row.credential_reference),
    credential: row.credential_version
      ? {
          authMode: row.auth_mode,
          version: row.credential_version,
          identifierLastFour: row.credential_identifier_last_four,
          verificationStatus: row.verification_status,
          webhookVerificationStatus: row.webhook_verification_status,
        }
      : null,
  }
}

async function readInfrastructureSnapshot(client, organizationId) {
  const result = await client.query(
    `SELECT kind, global_id
     FROM (
       SELECT 'integration_account'::text AS kind, global_id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND NOT (
           integration_type = 'commerce'
           AND provider = 'shopify'
         )
       UNION ALL
       SELECT 'warehouse', global_id
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
       UNION ALL
       SELECT 'printer', global_id
       FROM operations_printers
       WHERE organization_id = $1::uuid
       UNION ALL
       SELECT 'print_agent', global_id
       FROM operations_print_agents
       WHERE organization_id = $1::uuid
     ) retained
     ORDER BY kind, global_id`,
    [organizationId],
  )
  return result.rows.map((row) => `${row.kind}:${row.global_id}`)
}

async function readTarget(client, config) {
  const organizations = await client.query(
    `SELECT id::text, reference_code, name, organization_type, parent_id::text,
       is_demo
     FROM workspace_organizations
     WHERE lower(btrim(name)) = lower(btrim($1))
     ORDER BY created_at, id`,
    [config.targetName],
  )
  if (organizations.rows.length > 1) {
    fail('More than one workspace organization is named AG Alchemy, LLC')
  }
  const organization = organizations.rows[0] || null
  if (!organization) {
    return {
      state: 'absent',
      organization: null,
      membership: null,
      account: null,
    }
  }
  if (
    organization.organization_type !== 'root'
    || organization.parent_id
    || organization.is_demo
  ) {
    fail('Existing AG Alchemy, LLC workspace is not an independent root business')
  }
  const membership = (
    await client.query(
      `SELECT role, status, is_default
       FROM app_user_organization_memberships
       WHERE user_email = $1 AND organization_id = $2::uuid`,
      [config.actorEmail, organization.id],
    )
  ).rows[0] || null
  if (
    !membership
    || membership.role !== 'owner'
    || membership.status !== 'active'
    || membership.is_default
  ) {
    fail(
      'Existing AG Alchemy, LLC must be an active nondefault owner workspace for the configured actor',
    )
  }
  const accountRows = await client.query(
    `SELECT account.id::text, account.global_id,
       account.organization_id::text, account.provider,
       account.integration_type, account.environment,
       account.external_account_id, account.display_name, account.status,
       account.configuration, account.commerce_credential_generation,
       account.credential_reference, credential.auth_mode,
       credential.credential_version,
       credential.credential_identifier_last_four,
       credential.verification_status,
       credential.webhook_verification_status
     FROM operations_integration_accounts account
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND account.environment = 'sandbox'`,
    [organization.id],
  )
  if (accountRows.rows.length > 1) {
    fail('AG Alchemy, LLC has more than one Shopify sandbox account')
  }
  return {
    state: accountRows.rows[0] ? 'configured' : 'workspace_only',
    organization,
    membership,
    account: accountRows.rows[0]
      ? sourceAccountSummary(accountRows.rows[0])
      : null,
  }
}

async function readDevelopmentPlan(client, config) {
  const database = (
    await client.query(
      `SELECT current_database() AS database_name,
         (
           SELECT value ->> 'id'
           FROM app_settings
           WHERE key = 'deployment.database.identity'
         ) AS database_fingerprint`,
    )
  ).rows[0]
  if (!UUID_PATTERN.test(database?.database_fingerprint || '')) {
    fail('Development database identity is missing or invalid')
  }

  const actor = (
    await client.query(
      `SELECT email, role, status
       FROM app_users
       WHERE email = $1`,
      [config.actorEmail],
    )
  ).rows[0]
  if (!actor || actor.role !== 'owner' || actor.status !== 'active') {
    fail('Configured actor must be an active root application owner')
  }
  const memberships = await client.query(
    `SELECT organization.id::text AS organization_id,
       organization.reference_code, organization.name,
       membership.role, membership.status, membership.is_default
     FROM app_user_organization_memberships membership
     JOIN workspace_organizations organization
       ON organization.id = membership.organization_id
     WHERE membership.user_email = $1
       AND membership.status = 'active'
     ORDER BY membership.is_default DESC, organization.reference_code`,
    [config.actorEmail],
  )
  const defaults = memberships.rows.filter((row) => row.is_default)
  if (
    defaults.length !== 1
    || defaults[0].reference_code
      !== config.retainedDefaultOrganizationReference
  ) {
    fail('The retained default workspace does not match the approved plan')
  }
  const sourceMembership = memberships.rows.find(
    (row) => row.reference_code === config.sourceOrganizationReference,
  )
  if (
    !sourceMembership
    || sourceMembership.role !== 'owner'
    || sourceMembership.status !== 'active'
  ) {
    fail('The actor must remain an active owner of the source workspace')
  }

  const sourceOrganization = (
    await client.query(
      `SELECT id::text, reference_code, name, organization_type,
         parent_id::text, is_demo
       FROM workspace_organizations
       WHERE reference_code = $1`,
      [config.sourceOrganizationReference],
    )
  ).rows[0]
  if (
    !sourceOrganization
    || sourceOrganization.organization_type !== 'root'
    || sourceOrganization.parent_id
    || sourceOrganization.is_demo
  ) {
    fail('Source workspace must be an independent non-demo root business')
  }
  const sourceRows = await client.query(
    `SELECT account.id::text, account.global_id,
       account.organization_id::text, account.provider,
       account.integration_type, account.environment,
       account.external_account_id, account.display_name, account.status,
       account.configuration, account.commerce_credential_generation,
       account.credential_reference, credential.auth_mode,
       credential.credential_version,
       credential.credential_identifier_last_four,
       credential.verification_status,
       credential.webhook_verification_status
     FROM operations_integration_accounts account
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND account.environment = 'sandbox'`,
    [sourceOrganization.id, config.sourceAccountGlobalId],
  )
  if (sourceRows.rows.length !== 1) {
    fail('Approved source Shopify sandbox account was not found')
  }
  const source = sourceRows.rows[0]
  if (
    source.external_account_id !== config.shopExternalAccountId
    || source.configuration?.shopDomain !== config.shopDomain
    || source.configuration?.providerAccountId
      !== config.shopExternalAccountId
  ) {
    fail('Source Shopify provider identity does not match the approved store')
  }
  if (
    source.status !== 'disabled'
    || source.configuration?.domainWorkersActivated === true
    || source.configuration?.accessTokenPersisted === true
  ) {
    fail('Source Shopify connection must be disabled with no active domain worker')
  }
  approvedReadOnlyShopifyScopes(
    source.configuration?.grantedScopes,
    'Approved source Shopify connection evidence',
  )
  approvedReadOnlyShopifyScopes(
    source.configuration?.tokenGrantedScopes,
    'Approved source Shopify token evidence',
  )

  const dependencies = {}
  for (const [name, table] of [
    ['canonicalOrders', 'operations_orders'],
    ['externalIdentifiers', 'operations_external_identifiers'],
    ['productMappings', 'operations_product_mappings'],
    ['webhookReceipts', 'operations_commerce_webhook_receipts'],
  ]) {
    const result = await client.query(
      `SELECT count(*)::int AS count
       FROM ${table}
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [sourceOrganization.id, source.id],
    )
    dependencies[name] = numberValue(result.rows[0]?.count)
  }
  if (
    dependencies.canonicalOrders
    || dependencies.externalIdentifiers
    || dependencies.productMappings
    || dependencies.webhookReceipts
  ) {
    fail(
      'Source Shopify connection has durable domain or webhook dependencies and cannot be recreated',
    )
  }

  const cursors = await client.query(
    `SELECT resource, provider_cursor IS NOT NULL AS cursor_present,
       high_watermark IS NOT NULL AS high_watermark_present,
       reconciliation_status, records_seen::text, records_applied::text,
       records_held::text, consecutive_failures,
       last_error_code, last_started_at IS NOT NULL AS started,
       last_completed_at IS NOT NULL AS completed
     FROM operations_commerce_sync_cursors
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     ORDER BY resource`,
    [sourceOrganization.id, source.id],
  )
  const cursorSummary = cursors.rows.map((row) => ({
    resource: row.resource,
    cursorPresent: row.cursor_present,
    highWatermarkPresent: row.high_watermark_present,
    status: row.reconciliation_status,
    recordsSeen: numberValue(row.records_seen),
    recordsApplied: numberValue(row.records_applied),
    recordsHeld: numberValue(row.records_held),
    consecutiveFailures: numberValue(row.consecutive_failures),
    errorPresent: Boolean(row.last_error_code),
    started: row.started,
    completed: row.completed,
  }))
  if (
    JSON.stringify(cursorSummary.map((row) => row.resource))
      !== JSON.stringify(SHOPIFY_RESOURCES)
    || cursorSummary.some((row) => (
      row.cursorPresent
      || row.highWatermarkPresent
      || row.status !== 'idle'
      || row.recordsSeen
      || row.recordsApplied
      || row.recordsHeld
      || row.consecutiveFailures
      || row.errorPresent
      || row.started
      || row.completed
    ))
  ) {
    fail('Source Shopify cursors are not pristine and idle')
  }

  const attempts = await client.query(
    `SELECT action, state, count(*)::int AS count
     FROM operations_commerce_provider_attempts
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     GROUP BY action, state
     ORDER BY action, state`,
    [sourceOrganization.id, source.id],
  )
  const attemptSummary = attempts.rows.map((row) => ({
    action: row.action,
    state: row.state,
    count: numberValue(row.count),
  }))
  if (
    attemptSummary.some((row) => (
      !ALLOWED_SOURCE_ATTEMPTS.includes(row.action)
      || row.state !== 'succeeded'
    ))
  ) {
    fail('Source Shopify provider evidence is not bounded successful read-only evidence')
  }

  const previews = await client.query(
    `SELECT count(*)::int AS runs,
       COALESCE(sum(orders_staged), 0)::int AS rows,
       COALESCE(sum(canonical_orders_created), 0)::int AS canonical_orders,
       COALESCE(sum(shopify_writes), 0)::int AS shopify_writes,
       count(*) FILTER (WHERE sync_cursor_advanced)::int AS advanced_runs
     FROM operations_commerce_order_preview_runs
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [sourceOrganization.id, source.id],
  )
  const preview = {
    runs: numberValue(previews.rows[0]?.runs),
    rows: numberValue(previews.rows[0]?.rows),
    canonicalOrders: numberValue(previews.rows[0]?.canonical_orders),
    shopifyWrites: numberValue(previews.rows[0]?.shopify_writes),
    advancedRuns: numberValue(previews.rows[0]?.advanced_runs),
  }
  if (
    preview.runs > 1
    || preview.canonicalOrders
    || preview.shopifyWrites
    || preview.advancedRuns
  ) {
    fail('Source held preview is outside the disposable read-only boundary')
  }

  const target = await readTarget(client, config)
  const sourceSummary = sourceAccountSummary(source)
  let state
  if (sourceSummary.credential && !target.account) {
    state = 'ready'
    if (
      sourceSummary.credential.authMode !== 'shopify_client_credentials'
      || sourceSummary.credential.version
        !== sourceSummary.credentialGeneration
      || sourceSummary.credential.verificationStatus !== 'verified'
      || sourceSummary.credential.webhookVerificationStatus !== 'unverified'
      || !sourceSummary.credentialReferencePresent
      || sourceSummary.configuration.missingScopes.length
    ) {
      fail('Source Shopify credential is not a verified disabled generation')
    }
  } else if (!sourceSummary.credential && target.account) {
    state = 'already_complete'
    approvedReadOnlyShopifyScopes(
      target.account.configuration.grantedScopes,
      'Completed target Shopify connection evidence',
    )
    approvedReadOnlyShopifyScopes(
      target.account.configuration.tokenGrantedScopes,
      'Completed target Shopify token evidence',
    )
    if (
      target.account.externalAccountId !== config.shopExternalAccountId
      || target.account.configuration.shopDomain !== config.shopDomain
      || target.account.status !== 'active'
      || !target.account.credential
      || target.account.credential.authMode
        !== 'shopify_client_credentials'
      || target.account.credential.version
        !== target.account.credentialGeneration
      || target.account.credential.verificationStatus !== 'verified'
      || target.account.credential.webhookVerificationStatus !== 'unverified'
      || target.account.configuration.missingScopes.length
    ) {
      fail('Existing AG Alchemy Shopify connection is not the completed approved transfer')
    }
  } else {
    fail(
      'Source and target credential state is ambiguous; no transfer can be planned',
    )
  }

  const infrastructure = await readInfrastructureSnapshot(
    client,
    sourceOrganization.id,
  )
  const plan = {
    version: SCRIPT_VERSION,
    state,
    database: {
      name: database.database_name,
      fingerprint: database.database_fingerprint,
    },
    actor: {
      email: config.actorEmail,
      defaultOrganizationReference: defaults[0].reference_code,
      retainedMembershipReferences: memberships.rows
        .map((row) => row.reference_code)
        .sort(),
    },
    source: {
      organization: sourceOrganization,
      account: sourceSummary,
      cursors: cursorSummary,
      providerAttempts: attemptSummary,
      preview,
      dependencies,
      retainedInfrastructure: infrastructure,
    },
    target: {
      name: config.targetName,
      state: target.state,
      organization: target.organization
        ? {
            id: target.organization.id,
            referenceCode: target.organization.reference_code,
          }
        : null,
      account: target.account,
    },
    changes: state === 'ready'
      ? [
          'create-or-reuse-nondefault-root-workspace',
          'recreate-disabled-shopify-credential-with-target-aad',
          'create-fresh-idle-cursors',
          'clear-disposable-source-preview',
          'disconnect-source-credential',
          'retain-source-account-attempts-audits-and-global-id',
        ]
      : [],
  }
  return { plan, digest: planDigest(plan), internal: { source, target } }
}

function assertExpectedPlan(planResult, config) {
  if (planResult.plan.database.fingerprint !== config.expectedDatabaseFingerprint) {
    fail('Development database identity changed after plan approval')
  }
  if (planResult.digest !== config.expectedPlanDigest) {
    fail('Development correction plan changed after approval')
  }
}

async function audit(client, input) {
  await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload,
       subject, organization_id, is_system
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::uuid, false)`,
    [
      input.actorEmail,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload || {}),
      input.subject || input.actorEmail,
      input.organizationId,
    ],
  )
}

async function createTargetOrganization(client, config) {
  const organization = (
    await client.query(
      `INSERT INTO workspace_organizations (
         parent_id, name, organization_type, created_by, updated_by,
         created_at, updated_at
       ) VALUES (NULL, $1, 'root', $2, $2, now(), now())
       RETURNING id::text, reference_code, name`,
      [config.targetName, config.actorEmail],
    )
  ).rows[0]
  await client.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by, created_at, updated_at
     ) VALUES (
       $1, $2::uuid, 'owner', $3::jsonb, 'active', false,
       $1, $1, now(), now()
     )`,
    [
      config.actorEmail,
      organization.id,
      JSON.stringify(OWNER_PERMISSIONS),
    ],
  )
  await audit(client, {
    actorEmail: config.actorEmail,
    eventType: 'workspace.organization.created',
    aggregateType: 'workspace_organization',
    aggregateId: organization.id,
    organizationId: organization.id,
    subject: organization.name,
    payload: {
      organizationId: organization.id,
      organizationReferenceCode: organization.reference_code,
      organizationName: organization.name,
      organizationType: 'root',
    },
  })
  return organization
}

function targetConfigurationAfterVerification(
  sourceConfiguration,
  verification,
) {
  return {
    ...sourceConfiguration,
    accountName: verification.shopName,
    accessTokenPersisted: false,
    accessTokenLifetimeSeconds: verification.expiresIn,
    adapterVersion:
      `shopify-graphql-${verification.apiVersion}-control-v1`,
    apiVersion: verification.apiVersion,
    domainWorkersActivated: false,
    grantedScopes: verification.grantedScopes,
    lastVerifiedAt: verification.completedAt,
    missingScopes: verification.missingScopes,
    providerAccountId: verification.providerAccountId,
    requestedScopes: verification.requestedScopes,
    restrictedScopes: verification.requestedScopes.filter(
      (scope) => scope === 'read_all_orders',
    ),
    scopeProfile: 'receipt_evidence_v1',
    shopDomain: verification.shopDomain,
    tokenAcquisition: 'client_credentials',
    tokenGrantedScopes: verification.tokenGrantedScopes,
    webhookSecretVerified: false,
  }
}

function encryptedCredentialDigest(row) {
  const hash = crypto.createHash('sha256')
  for (const value of [
    row.credential_ciphertext,
    row.credential_iv,
    row.credential_tag,
  ]) {
    if (!Buffer.isBuffer(value) || !value.length) {
      fail('Stored Shopify credential encryption material is invalid')
    }
    hash.update(String(value.length))
    hash.update(':')
    hash.update(value)
    hash.update(';')
  }
  return hash.digest('hex')
}

async function probeSourceBeforeTransaction(pool, config, planResult, key) {
  const client = await pool.connect()
  let credentialRow
  let credential
  try {
    credentialRow = (
      await client.query(
        `SELECT credential_ciphertext, credential_iv, credential_tag
         FROM operations_commerce_credentials
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [
          planResult.plan.source.organization.id,
          planResult.internal.source.id,
        ],
      )
    ).rows[0]
    if (!credentialRow) {
      fail('Source Shopify credential disappeared before verification')
    }
    const credentialMaterialDigest = encryptedCredentialDigest(credentialRow)
    credential = decryptShopifyCredential({
      key,
      encrypted: {
        ciphertext: credentialRow.credential_ciphertext,
        iv: credentialRow.credential_iv,
        tag: credentialRow.credential_tag,
      },
      organizationId: planResult.plan.source.organization.id,
      provider: 'shopify',
      environment: 'sandbox',
      externalAccountId: config.shopExternalAccountId,
    })
    const requestedAt = new Date().toISOString()
    const probe = await probeShopifyReadOnly({
      shopDomain: config.shopDomain,
      externalAccountId: config.shopExternalAccountId,
      credential,
    })
    const completedAt = new Date().toISOString()
    return {
      ...probe,
      requestedAt,
      completedAt,
      credentialMaterialDigest,
    }
  } finally {
    credential && (credential.clientId = '')
    credential && (credential.clientSecret = '')
    credentialRow?.credential_ciphertext?.fill(0)
    credentialRow?.credential_iv?.fill(0)
    credentialRow?.credential_tag?.fill(0)
    client.release()
  }
}

async function executeTransfer(
  client,
  config,
  planResult,
  key,
  verification,
) {
  const source = planResult.internal.source
  const targetOrganization = planResult.internal.target.organization
    || await createTargetOrganization(client, config)
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1::text, 0)
     )`,
    [
      `commerce-credential:${targetOrganization.id}:shopify:sandbox:${config.shopExternalAccountId}`,
    ],
  )
  const credentialRow = (
    await client.query(
      `SELECT credential_ciphertext, credential_iv, credential_tag,
         credential_identifier_last_four
       FROM operations_commerce_credentials
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
       FOR UPDATE`,
      [source.organization_id, source.id],
    )
  ).rows[0]
  if (!credentialRow) {
    fail('Source Shopify credential disappeared before execution')
  }
  if (
    encryptedCredentialDigest(credentialRow)
      !== verification.credentialMaterialDigest
  ) {
    fail('Source Shopify credential changed after read-only verification')
  }
  const credential = decryptShopifyCredential({
    key,
    encrypted: {
      ciphertext: credentialRow.credential_ciphertext,
      iv: credentialRow.credential_iv,
      tag: credentialRow.credential_tag,
    },
    organizationId: source.organization_id,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId: config.shopExternalAccountId,
  })
  let encrypted
  try {
    encrypted = encryptShopifyCredential({
      key,
      credential,
      organizationId: targetOrganization.id,
      provider: 'shopify',
      environment: 'sandbox',
      externalAccountId: config.shopExternalAccountId,
    })
    const targetAccount = (
      await client.query(
        `INSERT INTO operations_integration_accounts (
           organization_id, provider, integration_type, environment,
           external_account_id, display_name, status, configuration,
           commerce_credential_generation, created_by, updated_by
         ) VALUES (
           $1::uuid, 'shopify', 'commerce', 'sandbox', $2, $3,
           'active', $4::jsonb, 1, $5, $5
         )
         RETURNING id::text, global_id`,
        [
          targetOrganization.id,
          config.shopExternalAccountId,
          source.display_name,
          JSON.stringify(targetConfigurationAfterVerification(
            source.configuration,
            verification,
          )),
          config.actorEmail,
        ],
      )
    ).rows[0]
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, last_error_code,
         webhook_verification_status, webhook_verified_at,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'shopify_client_credentials',
         $4, $5, $6, 1, $7, 'verified', $8::timestamptz, NULL,
         'unverified', NULL, $9, $9
       )`,
      [
        targetOrganization.id,
        targetAccount.id,
        config.shopExternalAccountId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        credentialRow.credential_identifier_last_four,
        verification.completedAt,
        config.actorEmail,
      ],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET credential_reference = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        targetOrganization.id,
        targetAccount.id,
        `commerce-credential:${targetAccount.id}:v1`,
      ],
    )
    for (const resource of SHOPIFY_RESOURCES) {
      await client.query(
        `INSERT INTO operations_commerce_sync_cursors (
           organization_id, integration_account_id, resource
         ) VALUES ($1::uuid, $2::uuid, $3)`,
        [targetOrganization.id, targetAccount.id, resource],
      )
    }
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        accountGlobalId: targetAccount.global_id,
        provider: 'shopify',
        environment: 'sandbox',
        credentialVersion: 1,
      }))
      .digest('hex')
    await client.query(
      `INSERT INTO operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         idempotency_key, request_hash, redacted_request, redacted_response,
         state, provider_reference, error_code, requested_at, completed_at,
         created_by
       ) VALUES (
         $1::uuid, $2::uuid, 'connection.verify', $3, $4, $5,
         $6::jsonb, $7::jsonb, 'succeeded', $8, NULL,
         $9::timestamptz, $10::timestamptz, $11
       )`,
      [
        targetOrganization.id,
        targetAccount.id,
        `shopify-graphql-${verification.apiVersion}-control-v1`,
        crypto.randomUUID(),
        requestHash,
        JSON.stringify({
          accountGlobalId: targetAccount.global_id,
          credentialVersion: 1,
        }),
        JSON.stringify({
          shopId: verification.providerAccountId,
          shopDomain: verification.shopDomain,
          grantedScopeCount: verification.grantedScopes.length,
          tokenLifetimeSeconds: verification.expiresIn,
        }),
        verification.providerAccountId,
        verification.requestedAt,
        verification.completedAt,
        config.actorEmail,
      ],
    )

    const previewDelete = await client.query(
      `DELETE FROM operations_commerce_order_preview_runs
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [source.organization_id, source.id],
    )
    await client.query(
      `DELETE FROM operations_commerce_credentials
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [source.organization_id, source.id],
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET status = 'disabled', credential_reference = NULL,
         updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [source.organization_id, source.id, config.actorEmail],
    )

    const transferId = crypto.randomUUID()
    const common = {
      transferId,
      planDigest: planResult.digest,
      reason: 'development_workspace_ownership_correction',
    }
    if (previewDelete.rowCount) {
      await audit(client, {
        actorEmail: config.actorEmail,
        eventType: 'commerce.shopify_order_preview.cleared',
        aggregateType: 'commerce_integration',
        aggregateId: source.global_id,
        organizationId: source.organization_id,
        payload: { previewRunsDeleted: previewDelete.rowCount, ...common },
      })
    }
    await audit(client, {
      actorEmail: config.actorEmail,
      eventType: 'commerce.credential.disconnected',
      aggregateType: 'commerce_integration',
      aggregateId: source.global_id,
      organizationId: source.organization_id,
      payload: common,
    })
    await audit(client, {
      actorEmail: config.actorEmail,
      eventType: 'commerce.credential.ownership_transferred_out',
      aggregateType: 'commerce_integration',
      aggregateId: source.global_id,
      organizationId: source.organization_id,
      payload: common,
    })
    await audit(client, {
      actorEmail: config.actorEmail,
      eventType: 'commerce.credential.connected',
      aggregateType: 'commerce_integration',
      aggregateId: targetAccount.global_id,
      organizationId: targetOrganization.id,
      payload: {
        ...common,
        authMode: 'shopify_client_credentials',
        credentialVersion: 1,
        externalAccountId: config.shopExternalAccountId,
        verificationRequired: false,
      },
    })
    await audit(client, {
      actorEmail: config.actorEmail,
      eventType: 'commerce.credential.ownership_transferred_in',
      aggregateType: 'commerce_integration',
      aggregateId: targetAccount.global_id,
      organizationId: targetOrganization.id,
      payload: common,
    })
    return {
      transferId,
      targetOrganization,
      targetAccount,
      previewRunsDeleted: previewDelete.rowCount || 0,
      sourceProviderAttemptCount: planResult.plan.source.providerAttempts
        .reduce((total, row) => total + row.count, 0),
    }
  } finally {
    credential.clientId = ''
    credential.clientSecret = ''
    encrypted?.ciphertext.fill(0)
    encrypted?.iv.fill(0)
    encrypted?.tag.fill(0)
    credentialRow.credential_ciphertext.fill(0)
    credentialRow.credential_iv.fill(0)
    credentialRow.credential_tag.fill(0)
  }
}

async function verifyPostflight(client, config, before, result, key) {
  const defaultMembership = await client.query(
    `SELECT organization.reference_code
     FROM app_user_organization_memberships membership
     JOIN workspace_organizations organization
       ON organization.id = membership.organization_id
     WHERE membership.user_email = $1
       AND membership.is_default`,
    [config.actorEmail],
  )
  assert.equal(
    defaultMembership.rows.length,
    1,
    'Actor must retain one default workspace',
  )
  assert.equal(
    defaultMembership.rows[0].reference_code,
    config.retainedDefaultOrganizationReference,
    'Default workspace must remain unchanged',
  )
  const sourceState = (
    await client.query(
      `SELECT account.status, account.external_account_id,
         account.credential_reference,
         EXISTS (
           SELECT 1 FROM operations_commerce_credentials credential
           WHERE credential.organization_id = account.organization_id
             AND credential.integration_account_id = account.id
         ) AS credential_present,
         (
           SELECT count(*)::int
           FROM operations_commerce_provider_attempts attempt
           WHERE attempt.organization_id = account.organization_id
             AND attempt.integration_account_id = account.id
         ) AS provider_attempts,
         (
           SELECT count(*)::int
           FROM operations_commerce_order_preview_runs preview
           WHERE preview.organization_id = account.organization_id
             AND preview.integration_account_id = account.id
         ) AS previews
       FROM operations_integration_accounts account
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2`,
      [
        before.plan.source.organization.id,
        before.plan.source.account.globalId,
      ],
    )
  ).rows[0]
  assert.equal(sourceState.status, 'disabled')
  assert.equal(
    sourceState.external_account_id,
    config.shopExternalAccountId,
  )
  assert.equal(sourceState.credential_reference, null)
  assert.equal(sourceState.credential_present, false)
  assert.equal(numberValue(sourceState.previews), 0)
  assert.equal(
    numberValue(sourceState.provider_attempts),
    result.sourceProviderAttemptCount,
  )

  const targetState = (
    await client.query(
      `SELECT account.status, account.external_account_id,
         account.commerce_credential_generation, account.credential_reference,
         account.configuration,
         credential.auth_mode, credential.credential_version,
         credential.verification_status, credential.verified_at,
         credential.webhook_verification_status,
         credential.credential_ciphertext, credential.credential_iv,
         credential.credential_tag
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2`,
      [result.targetOrganization.id, result.targetAccount.global_id],
    )
  ).rows[0]
  assert.equal(targetState.status, 'active')
  assert.equal(targetState.external_account_id, config.shopExternalAccountId)
  assert.equal(targetState.commerce_credential_generation, 1)
  assert.equal(targetState.credential_version, 1)
  assert.equal(targetState.verification_status, 'verified')
  assert.ok(targetState.verified_at)
  assert.equal(targetState.webhook_verification_status, 'unverified')
  assert.equal(targetState.configuration.shopDomain, config.shopDomain)
  assert.equal(
    targetState.configuration.providerAccountId,
    config.shopExternalAccountId,
  )
  assert.deepEqual(targetState.configuration.missingScopes, [])
  assert.equal(targetState.configuration.accessTokenPersisted, false)
  assert.equal(targetState.configuration.domainWorkersActivated, false)
  approvedReadOnlyShopifyScopes(
    targetState.configuration.grantedScopes,
    'Target Shopify connection evidence',
  )
  approvedReadOnlyShopifyScopes(
    targetState.configuration.tokenGrantedScopes,
    'Target Shopify token evidence',
  )
  assert.match(
    targetState.credential_reference,
    /^commerce-credential:[0-9a-f-]+:v1$/,
  )
  const targetCredential = decryptShopifyCredential({
    key,
    encrypted: {
      ciphertext: targetState.credential_ciphertext,
      iv: targetState.credential_iv,
      tag: targetState.credential_tag,
    },
    organizationId: result.targetOrganization.id,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId: config.shopExternalAccountId,
  })
  try {
    assert.equal(targetCredential.provider, 'shopify')
    assert.throws(
      () => decryptShopifyCredential({
        key,
        encrypted: {
          ciphertext: targetState.credential_ciphertext,
          iv: targetState.credential_iv,
          tag: targetState.credential_tag,
        },
        organizationId: before.plan.source.organization.id,
        provider: 'shopify',
        environment: 'sandbox',
        externalAccountId: config.shopExternalAccountId,
      }),
      /could not be decrypted/,
      'Target credential must reject the source organization AAD',
    )
  } finally {
    targetCredential.clientId = ''
    targetCredential.clientSecret = ''
  }
  const targetCursors = await client.query(
    `SELECT resource, reconciliation_status, records_seen, records_applied,
       records_held, provider_cursor, high_watermark
     FROM operations_commerce_sync_cursors
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     ORDER BY resource`,
    [result.targetOrganization.id, result.targetAccount.id],
  )
  assert.deepEqual(
    targetCursors.rows.map((row) => row.resource),
    SHOPIFY_RESOURCES,
  )
  assert.ok(targetCursors.rows.every((row) => (
    row.reconciliation_status === 'idle'
    && numberValue(row.records_seen) === 0
    && numberValue(row.records_applied) === 0
    && numberValue(row.records_held) === 0
    && row.provider_cursor === null
    && row.high_watermark === null
  )))
  const targetAttempts = await client.query(
    `SELECT action, state, provider_reference, error_code,
       redacted_request, redacted_response, completed_at
     FROM operations_commerce_provider_attempts
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     ORDER BY requested_at, id`,
    [result.targetOrganization.id, result.targetAccount.id],
  )
  assert.equal(targetAttempts.rows.length, 1)
  assert.equal(targetAttempts.rows[0].action, 'connection.verify')
  assert.equal(targetAttempts.rows[0].state, 'succeeded')
  assert.equal(
    targetAttempts.rows[0].provider_reference,
    config.shopExternalAccountId,
  )
  assert.equal(targetAttempts.rows[0].error_code, null)
  assert.ok(targetAttempts.rows[0].completed_at)
  assert.equal(
    targetAttempts.rows[0].redacted_request.accountGlobalId,
    result.targetAccount.global_id,
  )
  assert.equal(
    targetAttempts.rows[0].redacted_response.shopDomain,
    config.shopDomain,
  )
  assert.deepEqual(
    await readInfrastructureSnapshot(
      client,
      before.plan.source.organization.id,
    ),
    before.plan.source.retainedInfrastructure,
    'Carrier, warehouse, printer, and print-agent identities must remain unchanged',
  )
}

async function databasePool(environment) {
  const sslMode = normalizedText(
    environment.PGSSLMODE || environment.DATABASE_SSL,
  ).toLowerCase()
  return new Pool({
    connectionString: environment.DATABASE_URL,
    ssl: sslMode === 'require' || sslMode === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  })
}

async function planOnly(pool, config) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await readDevelopmentPlan(client, config)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function execute(pool, config, environment) {
  const approved = await planOnly(pool, config)
  assertExpectedPlan(approved, config)
  if (approved.plan.state === 'already_complete') {
    return {
      alreadyComplete: true,
      planDigest: approved.digest,
      target: approved.plan.target,
    }
  }
  let key
  let verification
  let client
  try {
    key = commerceEncryptionKey(environment)
    verification = await probeSourceBeforeTransaction(
      pool,
      config,
      approved,
      key,
    )
    client = await pool.connect()
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    await client.query(`SET LOCAL statement_timeout = '30s'`)
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [SCRIPT_VERSION],
    )
    const initial = await readDevelopmentPlan(client, config)
    assertExpectedPlan(initial, config)
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [
        `commerce-credential:${initial.plan.source.organization.id}:shopify:sandbox:${config.shopExternalAccountId}`,
      ],
    )
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [
        `shopify-order-preview:${initial.plan.source.organization.id}:${config.sourceAccountGlobalId}`,
      ],
    )
    await client.query(
      `SELECT id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid AND global_id = $2
       FOR UPDATE`,
      [
        initial.plan.source.organization.id,
        config.sourceAccountGlobalId,
      ],
    )
    const locked = await readDevelopmentPlan(client, config)
    assertExpectedPlan(locked, config)
    const result = await executeTransfer(
      client,
      config,
      locked,
      key,
      verification,
    )
    await verifyPostflight(client, config, locked, result, key)
    await client.query('COMMIT')
    return {
      ok: true,
      alreadyComplete: false,
      planDigest: locked.digest,
      transferId: result.transferId,
      targetOrganization: {
        id: result.targetOrganization.id,
        referenceCode: result.targetOrganization.reference_code,
        name: result.targetOrganization.name,
      },
      targetAccount: {
        id: result.targetAccount.id,
        globalId: result.targetAccount.global_id,
        status: 'active',
        verificationStatus: 'verified',
      },
      previewRunsDeleted: result.previewRunsDeleted,
      sourceEvidenceRetained: {
        globalId: locked.plan.source.account.globalId,
        providerAttempts: result.sourceProviderAttemptCount,
      },
      next: 'Switch to AG Alchemy, LLC and run a fresh held order preview.',
    }
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    key?.fill(0)
    client?.release()
  }
}

export function runSelfTest() {
  const oldOrganizationId = '11111111-1111-4111-8111-111111111111'
  const newOrganizationId = '22222222-2222-4222-8222-222222222222'
  const externalAccountId = 'gid://shopify/Shop/123456789'
  const environment = {
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY:
      'ag-alchemy-self-test-encryption-key-1234567890',
  }
  const key = commerceEncryptionKey(environment)
  const credential = {
    provider: 'shopify',
    authMode: 'shopify_client_credentials',
    clientId: 'self-test-client-id',
    clientSecret: 'self-test-client-secret-1234567890',
  }
  const oldEncrypted = encryptShopifyCredential({
    key,
    credential,
    organizationId: oldOrganizationId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId,
    iv: Buffer.alloc(12, 1),
  })
  const decrypted = decryptShopifyCredential({
    key,
    encrypted: oldEncrypted,
    organizationId: oldOrganizationId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId,
  })
  const newEncrypted = encryptShopifyCredential({
    key,
    credential: decrypted,
    organizationId: newOrganizationId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId,
    iv: Buffer.alloc(12, 2),
  })
  assert.deepEqual(
    decryptShopifyCredential({
      key,
      encrypted: newEncrypted,
      organizationId: newOrganizationId,
      provider: 'shopify',
      environment: 'sandbox',
      externalAccountId,
    }),
    credential,
  )
  assert.throws(
    () => decryptShopifyCredential({
      key,
      encrypted: newEncrypted,
      organizationId: oldOrganizationId,
      provider: 'shopify',
      environment: 'sandbox',
      externalAccountId,
    }),
    /could not be decrypted/,
  )
  const plan = { b: 2, a: { d: 4, c: 3 } }
  assert.equal(planDigest(plan), planDigest({ a: { c: 3, d: 4 }, b: 2 }))
  assert.notEqual(planDigest(plan), planDigest({ a: { c: 3, d: 5 }, b: 2 }))
  assert.throws(
    () => validateRuntimeEnvironment(
      {
        CLAWPILOT_STORAGE: 'postgres',
        RAILWAY_ENVIRONMENT_NAME: 'production',
        DATABASE_URL: 'postgres://example.invalid/test',
        APP_LOGIN_EMAIL: 'owner@example.test',
      },
      { actorEmail: 'owner@example.test' },
      'plan',
    ),
    /development/,
  )
  assert.doesNotThrow(
    () => validateRuntimeEnvironment(
      {
        CLAWPILOT_STORAGE: 'postgres',
        RAILWAY_ENVIRONMENT_NAME: 'development',
        RAILWAY_PROJECT_ID: TRUSTED_RAILWAY_PROJECT_ID,
        RAILWAY_ENVIRONMENT_ID:
          TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID,
        DATABASE_URL: 'postgres://example.invalid/test',
        APP_LOGIN_EMAIL: 'owner@example.test',
      },
      { actorEmail: 'owner@example.test' },
      'plan',
    ),
  )
  assert.doesNotThrow(
    () => validateRuntimeEnvironment(
      {
        CLAWPILOT_STORAGE: 'postgres',
        AG_ALCHEMY_DISPOSABLE_REHEARSAL_CONFIRM:
          DISPOSABLE_REHEARSAL_CONFIRMATION,
        DATABASE_URL: 'postgres://localhost/test',
        APP_LOGIN_EMAIL: 'owner@example.test',
      },
      { actorEmail: 'owner@example.test' },
      'plan',
    ),
  )
  assert.throws(
    () => validateRuntimeEnvironment(
      {
        CLAWPILOT_STORAGE: 'postgres',
        RAILWAY_ENVIRONMENT_NAME: 'development',
        AG_ALCHEMY_DISPOSABLE_REHEARSAL_CONFIRM:
          DISPOSABLE_REHEARSAL_CONFIRMATION,
        DATABASE_URL: 'postgres://localhost/test',
        APP_LOGIN_EMAIL: 'owner@example.test',
      },
      { actorEmail: 'owner@example.test' },
      'plan',
    ),
    /cannot run with Railway environment markers/,
  )
  key.fill(0)
  decrypted.clientId = ''
  decrypted.clientSecret = ''
  oldEncrypted.ciphertext.fill(0)
  newEncrypted.ciphertext.fill(0)
  return { ok: true, version: SCRIPT_VERSION }
}

function usage() {
  return `Usage:
  node scripts/establish-ag-alchemy-development.mjs --plan
  node scripts/establish-ag-alchemy-development.mjs --execute
  node scripts/establish-ag-alchemy-development.mjs --self-test

Required for plan and execute:
  AG_ALCHEMY_ACTOR_EMAIL
  AG_ALCHEMY_SOURCE_ORGANIZATION_REFERENCE
  AG_ALCHEMY_SOURCE_ACCOUNT_GLOBAL_ID
  AG_ALCHEMY_RETAIN_DEFAULT_ORGANIZATION_REFERENCE
  AG_ALCHEMY_SHOP_DOMAIN
  AG_ALCHEMY_SHOP_EXTERNAL_ACCOUNT_ID

Execute also requires:
  AG_ALCHEMY_DATABASE_FINGERPRINT
  AG_ALCHEMY_PLAN_DIGEST
  AG_ALCHEMY_CONFIRM=${EXECUTION_CONFIRMATION}

Plan is read-only. Execute is accepted only in the Railway development
environment with the trusted project and environment IDs compiled into this
one-time tool. Offline disposable rehearsal requires a local PostgreSQL URL,
no populated RAILWAY_* marker, and:
  AG_ALCHEMY_DISPOSABLE_REHEARSAL_CONFIRM=${DISPOSABLE_REHEARSAL_CONFIRMATION}
Before opening its write transaction, execute performs a Shopify
client-credentials token exchange and read-only identity/scope query. It never
activates receipt/domain workers or sends a Shopify GraphQL mutation.`
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (args.mode === 'self-test') {
    console.log(JSON.stringify(runSelfTest()))
    return
  }
  const config = configurationFromEnvironment(process.env, args.mode)
  validateRuntimeEnvironment(process.env, config, args.mode)
  const pool = await databasePool(process.env)
  try {
    if (args.mode === 'plan') {
      const result = await planOnly(pool, config)
      console.log(JSON.stringify({
        ok: true,
        mode: 'plan',
        planDigest: result.digest,
        plan: result.plan,
        executeConfirmation: EXECUTION_CONFIRMATION,
      }, null, 2))
      return
    }
    console.log(JSON.stringify(
      await execute(pool, config, process.env),
      null,
      2,
    ))
  } finally {
    await pool.end()
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      `establish-ag-alchemy-development failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exitCode = 1
  })
}
