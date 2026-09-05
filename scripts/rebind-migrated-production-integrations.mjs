#!/usr/bin/env node

/**
 * One-time, receipt-bound provider credential rebind for the three approved
 * DEV -> PROD workspace migrations.
 *
 * Safety properties:
 * - both database endpoints, both database identities, and both Railway
 *   environments are compiled and independently supplied;
 * - only the exact manifest/mapping/receipt allowlist is accepted;
 * - source secrets are decrypted in memory and only target-AAD ciphertext is
 *   persisted;
 * - no source cursor, webhook receipt, provider attempt, outbox, order, or
 *   mock-provider state is read or copied;
 * - provider identity/credentials and the Shopify production callback are
 *   verified before a target placeholder can activate;
 * - every target mutation is serialized and committed atomically. Provider
 *   webhook reconciliation is idempotent and precedes the database commit so
 *   an interrupted run safely resumes from a new reviewed plan.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SCRIPT_VERSION = 'migrated-production-provider-rebind-v1'
export const PLAN_FORMAT = 'clawpilot-migrated-production-provider-rebind-plan-v1'
export const RECEIPT_FORMAT = 'clawpilot-migrated-production-provider-rebind-receipt-v1'
export const MANAGED_REBIND_MATERIAL_FORMAT = 'clawpilot-managed-carrier-rebind-material-v1'
export const MIGRATION_SCRIPT_VERSION = 'sales-shipping-workspace-production-migration-v3'
export const MIGRATION_MANIFEST_FORMAT = 'clawpilot-sales-shipping-workspace-migration-plan-v3'
export const MIGRATION_MAPPING_FORMAT = 'clawpilot-sales-shipping-workspace-migration-mapping-v3'

export const RAILWAY_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const SOURCE_RAILWAY_ENVIRONMENT_ID = 'e4abd95f-825c-4242-b37b-825a92597e98'
export const TARGET_RAILWAY_ENVIRONMENT_ID = '058ce52f-1d3b-44bb-afe2-0df2bf24efb9'
export const SOURCE_DATABASE_IDENTITY = '750aa268-0e31-4065-a99c-4016e4d4fab1'
export const TARGET_DATABASE_IDENTITY = '0474a18c-649c-491b-bea1-7da006d21d81'
export const PRODUCTION_PUBLIC_ORIGIN = 'https://aiapp.eigenracing.com'

const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const GLOBAL_ID = /^(?:gia|gac|gwh)(?:[0-9]{7}|[0-9a-v]{12})$/u
const SECRET_FIELD = /(?:secret|token|password|ciphertext|\biv\b|\btag\b|accountnumber$)/iu
const SAFE_SECRET_STATUS_FIELDS = new Set(['webhookSecretVerified'])
const ZERO_SOURCE_ROWS_COPIED = Object.freeze({
  cursors: 0,
  webhookState: 0,
  webhookReceipts: 0,
  providerAttempts: 0,
  outbox: 0,
  orders: 0,
  mockProviders: 0,
  episcsCarrierCredentials: 0,
})
const SHOPIFY_API_VERSION = '2026-07'
const SHOPIFY_ORDER_TOPICS = Object.freeze([
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
  'orders/paid',
  'orders/fulfilled',
  'orders/partially_fulfilled',
])
const SHOPIFY_ORDER_INCLUDE_FIELDS = Object.freeze([
  'admin_graphql_api_id',
  'updated_at',
])
const SHOPIFY_MINIMUM_READ_SCOPES = Object.freeze([
  'read_inventory',
  'read_locations',
  'read_orders',
  'read_products',
])
const SHOPIFY_TOPIC_ENUMS = Object.freeze({
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'orders/edited': 'ORDERS_EDITED',
  'orders/cancelled': 'ORDERS_CANCELLED',
  'orders/paid': 'ORDERS_PAID',
  'orders/fulfilled': 'ORDERS_FULFILLED',
  'orders/partially_fulfilled': 'ORDERS_PARTIALLY_FULFILLED',
})
const SHOPIFY_TOPIC_FROM_ENUM = new Map(
  Object.entries(SHOPIFY_TOPIC_ENUMS).map(([topic, providerTopic]) => [providerTopic, topic]),
)
const COMMERCE_SYNC_RESOURCES = Object.freeze({
  shopify: Object.freeze(['orders', 'products', 'inventory', 'fulfillments', 'returns']),
  faire: Object.freeze(['orders', 'products', 'inventory', 'shipments', 'returns']),
})
const COMMERCE_HISTORY_MODES = Object.freeze([
  'new_orders_only',
  'last_7_days',
  'last_30_days',
  'last_60_days',
  'provider_all',
])

const AG_MANAGED_BY = 'ag-alchemy-episcs-sandbox-rating-delegation'
const AG_AUTHORITY_ORGANIZATION_REFERENCE = 'ga5122758'

export const WORKSPACES = Object.freeze([
  Object.freeze({
    key: 'ag-alchemy',
    sourceOrganizationId: '60832306-9876-4384-98e8-e179b427c3c1',
    sourceOrganizationReference: 'ga4166777',
    targetOrganizationId: '33785418-9927-4e10-a492-d3a44b9b6f21',
    targetOrganizationReference: 'ga42g1438l4j2s',
    accounts: Object.freeze([
      Object.freeze({
        sourceId: '03696a20-aaf4-4049-b0e3-051d9b937749',
        sourceGlobalId: 'gia5156705',
        provider: 'faire',
        integrationType: 'commerce',
        environment: 'production',
        externalAccountIdSha256: '9ebe274c5db9782fd0da927e41329d428e62aa68a6028ebe22e32810d42f88a2',
      }),
      Object.freeze({
        sourceId: 'da56c6d6-fddd-47c0-bf26-66cdfc42ae2c',
        sourceGlobalId: 'gia9286799',
        provider: 'shopify',
        integrationType: 'commerce',
        environment: 'sandbox',
        externalAccountIdSha256: '68308a772f11b6110d48de3da8a1360827c1dd616dfb5777992c49544a33d848',
      }),
      Object.freeze({
        sourceId: '010fd720-bfe8-4a4c-9f8d-581eb4b6b456',
        sourceGlobalId: 'gia3106288',
        sourceCarrierAccountId: '52fdba26-1dea-4649-9b40-1f93aee573f2',
        sourceCarrierAccountGlobalId: 'gac3534106',
        provider: 'fedex_rest',
        integrationType: 'carrier',
        environment: 'sandbox',
        rebindMode: 'source_authority',
        authorityIntegrationGlobalId: 'gia7335302',
        authorityCarrierAccountGlobalId: 'gac2368052',
        expectedLastFour: '1073',
        expectedAddressLine1: '101 Jegs Place',
      }),
      Object.freeze({
        sourceId: '72acd52d-a547-43f9-a78d-bb96e33e0525',
        sourceGlobalId: 'gia5910262',
        sourceCarrierAccountId: 'b1856b57-6522-46b2-a2f2-d7c622fdb2b0',
        sourceCarrierAccountGlobalId: 'gac9576332',
        provider: 'ups_rest',
        integrationType: 'carrier',
        environment: 'sandbox',
        rebindMode: 'source_authority',
        authorityIntegrationGlobalId: 'gia2057284',
        authorityCarrierAccountGlobalId: 'gac5139730',
        expectedLastFour: '3574',
        expectedAddressLine1: '101 Jegs Place',
      }),
    ]),
  }),
  Object.freeze({
    key: 'french-florist',
    sourceOrganizationId: 'ae747fcb-eb5f-426c-afff-ee56cf7aeb90',
    sourceOrganizationReference: 'gaorvsskfp0mbn',
    targetOrganizationId: '3b9ceada-a4ff-4363-8e78-6069dee76328',
    targetOrganizationReference: 'gakrnoh15krp9n',
    accounts: Object.freeze([
      Object.freeze({
        sourceId: 'c13e4e64-edae-4e73-9ae0-c116c1419688',
        sourceGlobalId: 'gia585rig3qiq7j',
        provider: 'shopify',
        integrationType: 'commerce',
        environment: 'production',
        externalAccountIdSha256: '3f38b0416975b74695e498db78b878a487b61d406cd2d1ab5deb59438358df12',
      }),
    ]),
  }),
  Object.freeze({
    key: 'test-pro-bakery-bites',
    sourceOrganizationId: 'c6c8e6e7-fffa-4969-9526-e99da0ab2754',
    sourceOrganizationReference: 'gauf1348k686f3',
    targetOrganizationId: 'c8fcf491-cf8c-469a-b03c-0026a762752c',
    targetOrganizationReference: 'gac10cb46e3rpl',
    accounts: Object.freeze([
      Object.freeze({
        sourceId: '28038134-b624-4b52-8518-e9740785e5c3',
        sourceGlobalId: 'giah34fedoa5b1o',
        provider: 'shopify',
        integrationType: 'commerce',
        environment: 'sandbox',
        externalAccountIdSha256: 'f47f0e6cc3e525a5d5604d8d499ef93381e843ff1cee9100c4283625b9cd0954',
      }),
      Object.freeze({
        sourceId: 'c8aa9ff7-35f4-44e9-9419-e54b7c977002',
        sourceGlobalId: 'gia4h85q2nhuig0',
        sourceCarrierAccountId: 'fe5953e0-ee8e-4b5b-8629-46a57d8282f4',
        sourceCarrierAccountGlobalId: 'gacdf85s635a8sq',
        provider: 'ups_rest',
        integrationType: 'carrier',
        environment: 'production',
        rebindMode: 'direct_credential',
        sourceAccountNumberFingerprint: '2c3fb57b1479db90951719c5870ee91b1fd413c17bd7e955a2405a5cd9117a68',
        sourceAddressFingerprint: '0863d99a3b63ef27377c5de5992a6906546659f20eb8a2355429b00592fb1e7c',
      }),
      Object.freeze({
        sourceId: '8abcaaa5-a2a6-4800-9a4d-941bd3761a8c',
        sourceGlobalId: 'gia83f2h5i45ud6',
        sourceCarrierAccountId: '05b50351-d29f-4954-b3a1-c08203289279',
        sourceCarrierAccountGlobalId: 'gacljo93c7qtd42',
        provider: 'ups_rest',
        integrationType: 'carrier',
        environment: 'sandbox',
        rebindMode: 'direct_credential',
        sourceAccountNumberFingerprint: '319a420658fcb7d5df25ac0477f1d0ebe14b76abdf619e74c7fc95fc0b30483a',
        sourceAddressFingerprint: '0863d99a3b63ef27377c5de5992a6906546659f20eb8a2355429b00592fb1e7c',
      }),
    ]),
  }),
])

function fail(message) {
  throw new Error(message)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value) {
  return crypto.createHash('sha256').update(
    Buffer.isBuffer(value) ? value : String(value),
  ).digest('hex')
}

export function digest(value) {
  return sha256(canonicalJson(value))
}

function manifestDigest(value) {
  const copy = structuredClone(value)
  delete copy.manifestDigest
  return digest(copy)
}

function planDigest(value) {
  const copy = structuredClone(value)
  delete copy.planDigest
  return digest(copy)
}

function receiptIdentityDigest(value) {
  const copy = structuredClone(value)
  delete copy.receiptIdentityDigest
  return digest(copy)
}

function safeJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function parsePrivateJson(input, label) {
  const resolved = path.resolve(text(input))
  if (!resolved || !fs.existsSync(resolved)) fail(`${label} does not exist`)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) fail(`${label} must be a regular file`)
  if ((stat.mode & 0o077) !== 0) fail(`${label} must use private 0600 permissions`)
  let value
  try {
    value = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  } catch {
    fail(`${label} is not valid JSON`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must contain one JSON object`)
  }
  return value
}

const MANAGED_SECRET_INPUT_MAX_BYTES = 16 * 1024

export function readBoundedSecretJsonFd(fdValue, label = 'Managed carrier secret input') {
  const fd = Number(fdValue)
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255) {
    fail(`${label} file descriptor is invalid`)
  }
  const raw = Buffer.alloc(MANAGED_SECRET_INPUT_MAX_BYTES + 1)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFIFO()) fail(`${label} must come from an anonymous or named pipe`)
    let length = 0
    while (length < raw.length) {
      const bytesRead = fs.readSync(fd, raw, length, raw.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MANAGED_SECRET_INPUT_MAX_BYTES) fail(`${label} exceeds the safe size limit`)
    let value
    try {
      value = JSON.parse(raw.subarray(0, length).toString('utf8').trim())
    } catch {
      fail(`${label} is not valid JSON`)
    }
    assertExactObjectKeys(
      value,
      ['clientId', 'clientSecret', 'accountNumber'],
      label,
    )
    return {
      clientId: boundedPrintableAscii(value.clientId, 'Managed carrier client ID', 3, 512),
      clientSecret: boundedPrintableAscii(
        value.clientSecret,
        'Managed carrier client secret',
        8,
        4096,
      ),
      accountNumber: boundedPrintableAscii(
        value.accountNumber,
        'Managed carrier account number',
        4,
        128,
      ),
    }
  } finally {
    raw.fill(0)
    try {
      fs.closeSync(fd)
    } catch {
      // The descriptor may already have been closed by a failed inherited-pipe read.
    }
  }
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be one object`)
  }
  const observed = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    fail(`${label} contains missing or unsupported fields`)
  }
}

export function writePrivateJson(output, value) {
  const resolved = path.resolve(text(output))
  if (!resolved) fail('A private output path is required')
  if (fs.existsSync(resolved)) fail('Refusing to overwrite an existing evidence artifact')
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 })
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.linkSync(temporary, resolved)
    fs.unlinkSync(temporary)
    const directory = fs.openSync(path.dirname(resolved), 'r')
    try {
      fs.fsyncSync(directory)
    } finally {
      fs.closeSync(directory)
    }
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor)
      descriptor = undefined
    }
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  if ((fs.statSync(resolved).mode & 0o077) !== 0) {
    fail('Evidence artifact permissions are not private')
  }
}

function assertNoSecrets(value, label = 'evidence') {
  const visit = (candidate, trail) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${trail}[${index}]`))
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, entry] of Object.entries(candidate)) {
      if (
        SECRET_FIELD.test(key)
        && !(SAFE_SECRET_STATUS_FIELDS.has(key) && typeof entry === 'boolean')
      ) fail(`${label} contains a secret-shaped field at ${trail}.${key}`)
      visit(entry, `${trail}.${key}`)
    }
  }
  visit(value, '$')
}

function requiredSecret(environment, name) {
  const value = String(environment[name] || '')
  if (value.length < 32) fail(`${name} is required and must be at least 32 characters`)
  return value
}

function validatedDatabaseUrl(value, label) {
  const raw = String(value || '')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    fail(`${label} must be a PostgreSQL URL`)
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    fail(`${label} must be a PostgreSQL URL`)
  }
  if (!parsed.pathname.replace(/^\//u, '')) fail(`${label} must include a database name`)
  return raw
}

export function databaseEndpointFingerprint(connectionString) {
  const parsed = new URL(validatedDatabaseUrl(connectionString, 'database endpoint'))
  return digest({
    protocol: parsed.protocol.toLowerCase(),
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.replace(/^\//u, '')),
    user: decodeURIComponent(parsed.username || ''),
  })
}

function assertRailwayBoundary(environment) {
  assertTargetRailwayBoundary(environment)
  const expected = {
    SOURCE_RAILWAY_PROJECT_ID: RAILWAY_PROJECT_ID,
    SOURCE_RAILWAY_ENVIRONMENT_ID,
    SOURCE_RAILWAY_ENVIRONMENT_NAME: 'development',
  }
  for (const [name, required] of Object.entries(expected)) {
    if (text(environment[name]) !== required) {
      fail(`${name} does not match the compiled Railway migration boundary`)
    }
  }
}

function assertTargetRailwayBoundary(environment) {
  const expected = {
    TARGET_RAILWAY_PROJECT_ID: RAILWAY_PROJECT_ID,
    TARGET_RAILWAY_ENVIRONMENT_ID,
    TARGET_RAILWAY_ENVIRONMENT_NAME: 'production',
  }
  for (const [name, required] of Object.entries(expected)) {
    if (text(environment[name]) !== required) {
      fail(`${name} does not match the compiled Railway migration boundary`)
    }
  }
}

function targetEndpointBinding(environment, targetUrl) {
  const expected = text(environment.TARGET_DATABASE_ENDPOINT_SHA256).toLowerCase()
  if (!SHA256.test(expected)) fail('The reviewed target database endpoint binding is required')
  const observed = databaseEndpointFingerprint(targetUrl)
  if (observed !== expected) fail('Target database endpoint binding changed')
  return observed
}

function endpointBindings(environment, sourceUrl, targetUrl) {
  const sourceExpected = text(environment.SOURCE_DATABASE_ENDPOINT_SHA256).toLowerCase()
  const targetExpected = text(environment.TARGET_DATABASE_ENDPOINT_SHA256).toLowerCase()
  if (!SHA256.test(sourceExpected) || !SHA256.test(targetExpected)) {
    fail('Both independently reviewed database endpoint SHA-256 bindings are required')
  }
  const sourceObserved = databaseEndpointFingerprint(sourceUrl)
  const targetObserved = databaseEndpointFingerprint(targetUrl)
  if (sourceObserved !== sourceExpected) fail('Source database endpoint binding changed')
  if (targetObserved !== targetExpected) fail('Target database endpoint binding changed')
  if (sourceObserved === targetObserved) fail('Source and target databases must be different')
  return { source: sourceObserved, target: targetObserved }
}

function derivedKey(secret) {
  return crypto.createHash('sha256').update(secret).digest()
}

function decryptAesGcm(fields, keySecret, aad, label) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(keySecret), fields.iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(fields.tag)
    return Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ])
  } catch {
    fail(`${label} could not be decrypted under the approved source binding`)
  }
}

function encryptAesGcm(plaintext, keySecret, aad) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(keySecret), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

function commerceAad(organizationId, provider, environment, externalAccountId) {
  return `clawpilot:commerce:${organizationId}:${provider}:${environment}:${externalAccountId}:credential:v1`
}

function carrierCredentialAad(organizationId, provider, environment) {
  return `clawpilot:carrier:${organizationId}:${provider}:${environment}:credential:v1`
}

function carrierAccountAad(organizationId, provider, environment, globalId) {
  return `clawpilot:carrier:${organizationId}:${provider}:${environment}:account:${globalId}:v1`
}

function parseCredentialJson(buffer, label) {
  let value
  try {
    value = JSON.parse(buffer.toString('utf8'))
  } catch {
    fail(`${label} plaintext is not valid credential JSON`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} plaintext is not a credential object`)
  }
  return value
}

function carrierAccountFingerprint(keySecret, organizationId, provider, environment, accountNumber) {
  const key = crypto.createHmac('sha256', derivedKey(keySecret))
    .update('clawpilot:carrier:fingerprint:v1', 'utf8')
    .digest()
  return crypto.createHmac('sha256', key)
    .update(`${organizationId}:${provider}:${environment}:${accountNumber}`, 'utf8')
    .digest('hex')
}

export function carrierAddressFingerprint(input) {
  const address = normalizeCarrierAddress(input)
  return sha256(JSON.stringify({
    line1: address.line1.toLowerCase(),
    line2: address.line2?.toLowerCase() || null,
    city: address.city.toLowerCase(),
    region: address.region.toLowerCase(),
    postalCode: address.postalCode.toLowerCase().replace(/[\s-]/gu, ''),
    countryCode: address.countryCode,
  }))
}

function normalizeCarrierAddress(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Carrier account registered address is invalid')
  }
  const compact = (value) => String(value || '').trim().replace(/\s+/gu, ' ')
  const address = {
    line1: compact(input.line1),
    line2: compact(input.line2) || null,
    city: compact(input.city),
    region: compact(input.region),
    postalCode: compact(input.postalCode),
    countryCode: compact(input.countryCode || 'US').toUpperCase(),
  }
  if (
    !address.line1 || !address.city || !address.region || !address.postalCode
    || address.line1.length > 160
    || (address.line2 !== null && address.line2.length > 120)
    || address.city.length > 100
    || address.region.length > 100
    || address.postalCode.length > 32
    || !/^[A-Z]{2}$/u.test(address.countryCode)
  ) fail('Carrier account registered address is invalid')
  return address
}

function boundedPrintable(value, label, minimum = 1, maximum = 8192) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < minimum || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) fail(`${label} is invalid`)
  return normalized
}

function boundedPrintableAscii(value, label, minimum, maximum) {
  const normalized = String(value || '').trim()
  if (
    normalized.length < minimum || normalized.length > maximum
    || !/^[\x20-\x7e]+$/u.test(normalized)
  ) fail(`${label} is invalid`)
  return normalized
}

function safeProviderError(provider, operation) {
  return new Error(`${provider} ${operation} failed without verified evidence`)
}

async function boundedJsonResponse(response, provider, operation, limit = 256 * 1024) {
  let bytes
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch {
    throw safeProviderError(provider, operation)
  }
  if (bytes.length > limit || !response.ok) throw safeProviderError(provider, operation)
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object') throw new Error('invalid')
    return value
  } catch {
    throw safeProviderError(provider, operation)
  }
}

function exactHttpsUri(value, label) {
  let parsed
  try {
    parsed = new URL(String(value || ''))
  } catch {
    fail(`${label} must be a public HTTPS URL`)
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.hash || parsed.hostname.toLowerCase() !== 'aiapp.eigenracing.com'
  ) fail(`${label} must use the compiled ClawPilot production origin`)
  return parsed.toString()
}

function callbackUri(accountGlobalId) {
  if (!GLOBAL_ID.test(accountGlobalId) || !accountGlobalId.startsWith('gia')) {
    fail('Target Shopify account Global ID is invalid')
  }
  return exactHttpsUri(
    new URL(
      `/api/integrations/commerce/shopify/webhooks/${accountGlobalId}`,
      PRODUCTION_PUBLIC_ORIGIN,
    ).toString(),
    'Shopify callback URI',
  )
}

function defaultProviderEndpoints() {
  return Object.freeze({
    faire: 'https://www.faire.com/external-api/v2',
    ups_rest: Object.freeze({
      sandbox: Object.freeze({
        token: 'https://wwwcie.ups.com/security/v1/oauth/token',
        rate: 'https://wwwcie.ups.com/api/rating/v2409/Shop',
      }),
      production: Object.freeze({
        token: 'https://onlinetools.ups.com/security/v1/oauth/token',
        rate: 'https://onlinetools.ups.com/api/rating/v2409/Shop',
      }),
    }),
    fedex_rest: Object.freeze({
      sandbox: Object.freeze({
        token: 'https://apis-sandbox.fedex.com/oauth/token',
        rate: 'https://apis-sandbox.fedex.com/rate/v1/rates/quotes',
      }),
      production: Object.freeze({
        token: 'https://apis.fedex.com/oauth/token',
        rate: 'https://apis.fedex.com/rate/v1/rates/quotes',
      }),
    }),
  })
}

function providerEndpoints(runtime) {
  if (runtime.providerEndpoints && runtime.allowTestProviderEndpoints !== true) {
    fail('Provider endpoint overrides are test-only')
  }
  return runtime.providerEndpoints || defaultProviderEndpoints()
}

async function shopifyGraphql(fetchImpl, shopDomain, accessToken, input) {
  const response = await fetchImpl(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify(input),
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
    },
  )
  const payload = await boundedJsonResponse(response, 'Shopify', input.operationName)
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw safeProviderError('Shopify', input.operationName)
  }
  if (!payload.data || typeof payload.data !== 'object') {
    throw safeProviderError('Shopify', input.operationName)
  }
  return payload.data
}

async function shopifyRuntime(fetchImpl, credential, configuration) {
  if (
    credential.provider !== 'shopify'
    || credential.authMode !== 'shopify_client_credentials'
  ) fail('Stored Shopify credential payload is invalid')
  const shopDomain = boundedPrintable(
    configuration.shopDomain,
    'Stored Shopify shop domain',
    4,
    255,
  ).toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(shopDomain)) {
    fail('Stored Shopify shop domain is invalid')
  }
  const clientId = boundedPrintable(credential.clientId, 'Stored Shopify client ID', 8, 255)
  const clientSecret = boundedPrintable(
    credential.clientSecret,
    'Stored Shopify client secret',
    16,
    4096,
  )
  const response = await fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit',
  })
  const payload = await boundedJsonResponse(response, 'Shopify', 'credential validation', 64 * 1024)
  const accessToken = boundedPrintable(payload.access_token, 'Shopify access-token response', 8, 8192)
  return { shopDomain, accessToken }
}

async function verifyShopify(fetchImpl, credential, configuration) {
  const runtime = await shopifyRuntime(fetchImpl, credential, configuration)
  const data = await shopifyGraphql(fetchImpl, runtime.shopDomain, runtime.accessToken, {
    query: `query ClawPilotMigrationIdentityProbe {
      shop { id myshopifyDomain name }
      currentAppInstallation { accessScopes { handle } }
    }`,
    operationName: 'ClawPilotMigrationIdentityProbe',
  })
  const shop = safeJson(data.shop)
  const installation = safeJson(data.currentAppInstallation)
  const externalAccountId = boundedPrintable(shop.id, 'Shopify shop identity', 8, 255)
  if (!/^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/u.test(externalAccountId)) {
    fail('Shopify returned an invalid shop identity')
  }
  const canonicalDomain = boundedPrintable(shop.myshopifyDomain, 'Shopify canonical domain', 4, 255)
    .toLowerCase()
  if (canonicalDomain !== runtime.shopDomain) fail('Shopify canonical shop domain changed')
  const scopes = Array.isArray(installation.accessScopes)
    ? installation.accessScopes.map((entry) => boundedPrintable(
      safeJson(entry).handle,
      'Shopify granted scope',
      2,
      128,
    )).sort()
    : fail('Shopify returned invalid access-scope evidence')
  const effective = (scope) => scopes.includes(scope)
    || (scope.startsWith('read_') && scopes.includes(`write_${scope.slice(5)}`))
  const recordedScopes = Array.isArray(configuration.grantedScopes)
    ? configuration.grantedScopes.map((scope) => boundedPrintable(
        scope,
        'Recorded Shopify granted scope',
        2,
        128,
      ))
    : []
  const requiredScopes = [...new Set([
    ...SHOPIFY_MINIMUM_READ_SCOPES,
    ...recordedScopes,
  ])]
  if (requiredScopes.some((scope) => !effective(scope))) {
    fail('Shopify no longer grants the approved source capabilities')
  }
  return {
    externalAccountId,
    identitySha256: sha256(externalAccountId),
    accountName: boundedPrintable(shop.name, 'Shopify account name', 1, 255),
    shopDomain: canonicalDomain,
    grantedScopes: [...new Set(scopes)],
    runtime,
    operationalProbe: 'identity_scopes_webhooks_read_only',
    providerMutationCount: 0,
  }
}

function normalizeWebhookReadiness(data, desiredUri) {
  const connection = safeJson(data.webhookSubscriptions)
  const pageInfo = safeJson(connection.pageInfo)
  if (
    !Array.isArray(connection.nodes)
    || pageInfo.hasNextPage !== false
    || pageInfo.endCursor !== null
  ) fail('Shopify order webhook discovery was incomplete')
  const subscriptions = connection.nodes.map((entry) => {
    const node = safeJson(entry)
    const topic = SHOPIFY_TOPIC_FROM_ENUM.get(node.topic)
    const includeFields = Array.isArray(node.includeFields)
      ? node.includeFields.map((value) => boundedPrintable(
        value,
        'Shopify webhook include field',
        1,
        128,
      )).sort()
      : fail('Shopify returned malformed webhook evidence')
    if (
      !topic || typeof node.id !== 'string'
      || !/^gid:\/\/shopify\/WebhookSubscription\/[1-9][0-9]*$/u.test(node.id)
      || typeof node.uri !== 'string'
      || !['JSON', 'XML'].includes(node.format)
    ) fail('Shopify returned malformed webhook evidence')
    return {
      providerId: node.id,
      topic,
      uri: node.uri,
      format: node.format,
      includeFields,
      exact: node.uri === desiredUri && node.format === 'JSON'
        && canonicalJson(includeFields) === canonicalJson([...SHOPIFY_ORDER_INCLUDE_FIELDS].sort()),
    }
  }).sort((left, right) => (
    left.topic.localeCompare(right.topic) || left.providerId.localeCompare(right.providerId)
  ))
  const actions = []
  for (const topic of SHOPIFY_ORDER_TOPICS) {
    const current = subscriptions.filter((entry) => entry.topic === topic)
    if (current.length > 1) fail(`Shopify has duplicate ${topic} subscriptions requiring review`)
    if (!current.length) actions.push({ action: 'create', topic, providerId: null })
    else if (!current[0].exact) {
      actions.push({ action: 'update', topic, providerId: current[0].providerId })
    }
  }
  return {
    desiredUri,
    actions,
    ready: actions.length === 0,
    observed: subscriptions.map(({ providerId, topic, uri, format, includeFields, exact }) => ({
      providerIdSha256: sha256(providerId),
      topic,
      uriSha256: sha256(uri),
      format,
      includeFields,
      exact,
    })),
  }
}

async function inspectShopifyWebhooks(fetchImpl, runtime, desiredUri) {
  const data = await shopifyGraphql(fetchImpl, runtime.shopDomain, runtime.accessToken, {
    query: `query ClawPilotMigrationOrderWebhookProbe($topics: [WebhookSubscriptionTopic!]) {
      webhookSubscriptions(first: 100, topics: $topics) {
        nodes { id topic uri format includeFields }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    operationName: 'ClawPilotMigrationOrderWebhookProbe',
    variables: { topics: SHOPIFY_ORDER_TOPICS.map((topic) => SHOPIFY_TOPIC_ENUMS[topic]) },
  })
  return normalizeWebhookReadiness(data, desiredUri)
}

async function mutateShopifyWebhook(fetchImpl, runtime, desiredUri, action) {
  const update = action.action === 'update'
  const field = update ? 'webhookSubscriptionUpdate' : 'webhookSubscriptionCreate'
  const data = await shopifyGraphql(fetchImpl, runtime.shopDomain, runtime.accessToken, {
    query: update
      ? `mutation ClawPilotMigrationOrderWebhookUpdate($id: ID!, $subscription: WebhookSubscriptionInput!) {
          webhookSubscriptionUpdate(id: $id, webhookSubscription: $subscription) {
            webhookSubscription { id topic uri format includeFields }
            userErrors { field message }
          }
        }`
      : `mutation ClawPilotMigrationOrderWebhookCreate($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
            webhookSubscription { id topic uri format includeFields }
            userErrors { field message }
          }
        }`,
    operationName: update
      ? 'ClawPilotMigrationOrderWebhookUpdate'
      : 'ClawPilotMigrationOrderWebhookCreate',
    variables: update
      ? {
          id: action.providerId,
          subscription: {
            uri: desiredUri,
            format: 'JSON',
            includeFields: [...SHOPIFY_ORDER_INCLUDE_FIELDS],
          },
        }
      : {
          topic: SHOPIFY_TOPIC_ENUMS[action.topic],
          subscription: {
            uri: desiredUri,
            format: 'JSON',
            includeFields: [...SHOPIFY_ORDER_INCLUDE_FIELDS],
          },
        },
  })
  const result = safeJson(data[field])
  if (!Array.isArray(result.userErrors) || result.userErrors.length) {
    throw safeProviderError('Shopify', 'order webhook reconciliation')
  }
  const node = safeJson(result.webhookSubscription)
  if (
    node.topic !== SHOPIFY_TOPIC_ENUMS[action.topic]
    || node.uri !== desiredUri || node.format !== 'JSON'
    || !Array.isArray(node.includeFields)
    || canonicalJson([...node.includeFields].sort())
      !== canonicalJson([...SHOPIFY_ORDER_INCLUDE_FIELDS].sort())
    || (update && node.id !== action.providerId)
    || !/^gid:\/\/shopify\/WebhookSubscription\/[1-9][0-9]*$/u.test(String(node.id || ''))
  ) throw safeProviderError('Shopify', 'order webhook reconciliation')
}

async function reconcileShopifyWebhooks(fetchImpl, runtime, desiredUri, expectedActions) {
  const before = await inspectShopifyWebhooks(fetchImpl, runtime, desiredUri)
  if (canonicalJson(before.actions) !== canonicalJson(expectedActions)) {
    fail('Shopify webhook state changed after the reviewed rebind plan')
  }
  for (const action of before.actions) {
    await mutateShopifyWebhook(fetchImpl, runtime, desiredUri, action)
  }
  const after = await inspectShopifyWebhooks(fetchImpl, runtime, desiredUri)
  if (!after.ready) fail('Shopify production webhook callback could not be verified')
  return after
}

async function verifyFaire(fetchImpl, credential, endpoints) {
  if (credential.provider !== 'faire' || !['faire_brand_token', 'faire_oauth'].includes(
    credential.authMode,
  )) fail('Stored Faire credential payload is invalid')
  const accessToken = boundedPrintable(credential.accessToken, 'Stored Faire access token', 8, 8192)
  const headers = { Accept: 'application/json' }
  if (credential.authMode === 'faire_oauth') {
    const applicationId = boundedPrintable(credential.applicationId, 'Faire application ID', 1, 255)
    const applicationSecret = boundedPrintable(
      credential.applicationSecret,
      'Faire application secret',
      16,
      4096,
    )
    headers['X-FAIRE-APP-CREDENTIALS'] = Buffer.from(
      `${applicationId}:${applicationSecret}`,
      'utf8',
    ).toString('base64')
    headers['X-FAIRE-OAUTH-ACCESS-TOKEN'] = accessToken
  } else {
    headers['X-FAIRE-ACCESS-TOKEN'] = accessToken
  }
  const response = await fetchImpl(`${endpoints.faire}/brands/profile`, {
    method: 'GET', headers, redirect: 'error', cache: 'no-store', credentials: 'omit',
  })
  const profile = await boundedJsonResponse(response, 'Faire', 'brand identity probe')
  const orderResponse = await fetchImpl(`${endpoints.faire}/orders?limit=1`, {
    method: 'GET', headers, redirect: 'error', cache: 'no-store', credentials: 'omit',
  })
  const orderProbe = await boundedJsonResponse(orderResponse, 'Faire', 'order read probe')
  if (!Array.isArray(orderProbe.orders)) {
    throw safeProviderError('Faire', 'order read probe')
  }
  const identities = [profile.id, profile.brand_id, profile.brandId]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => boundedPrintable(value, 'Faire brand identity', 1, 255))
  if (!identities.length || new Set(identities).size !== 1) {
    fail('Faire returned ambiguous brand identity evidence')
  }
  return {
    externalAccountId: identities[0],
    identitySha256: sha256(identities[0]),
    accountName: boundedPrintable(
      profile.name || profile.brand_name || profile.brandName,
      'Faire brand name',
      1,
      255,
    ),
    operationalProbe: 'orders_read_only',
    providerMutationCount: 0,
  }
}

function carrierProbeBody(provider, accountNumber, address) {
  const streetLines = [address.line1, ...(address.line2 ? [address.line2] : [])]
  if (provider === 'ups_rest') {
    const upsAddress = {
      AddressLine: streetLines,
      City: address.city,
      StateProvinceCode: address.region,
      PostalCode: address.postalCode,
      CountryCode: address.countryCode,
    }
    return {
      RateRequest: {
        Request: {
          RequestOption: 'Shop',
          TransactionReference: { CustomerContext: 'ClawPilot migration credential verification' },
        },
        Shipment: {
          Shipper: {
            Name: 'ClawPilot migration verification',
            ShipperNumber: accountNumber,
            Address: upsAddress,
          },
          ShipFrom: { Name: 'ClawPilot migration verification', Address: upsAddress },
          ShipTo: {
            Name: 'ClawPilot migration verification',
            Address: {
              AddressLine: ['1 ClawPilot Way'],
              City: 'Hartford',
              StateProvinceCode: 'CT',
              PostalCode: '06103',
              CountryCode: 'US',
            },
          },
          PaymentDetails: {
            ShipmentCharge: [{
              Type: '01',
              BillShipper: { AccountNumber: accountNumber },
            }],
          },
          NumOfPieces: '1',
          Package: [{
            PackagingType: { Code: '02', Description: 'Customer supplied package' },
            Description: 'ClawPilot migration verification',
            Dimensions: {
              UnitOfMeasurement: { Code: 'IN' },
              Length: '6', Width: '6', Height: '6',
            },
            PackageWeight: {
              UnitOfMeasurement: { Code: 'LBS' },
              Weight: '1',
            },
          }],
          ShipmentRatingOptions: { NegotiatedRatesIndicator: '' },
        },
      },
    }
  }
  return {
    accountNumber: { value: accountNumber },
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: {
        contact: {
          personName: 'ClawPilot Operator',
          companyName: 'ClawPilot migration verification',
        },
        address: {
          streetLines,
          city: address.city,
          stateOrProvinceCode: address.region,
          postalCode: address.postalCode,
          countryCode: address.countryCode,
        },
      },
      recipient: {
        contact: {
          personName: 'ClawPilot Operator',
          companyName: 'ClawPilot migration verification',
        },
        address: {
          streetLines: ['1 ClawPilot Way'],
          city: 'Hartford',
          stateOrProvinceCode: 'CT',
          postalCode: '06103',
          countryCode: 'US',
        },
      },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['ACCOUNT'],
      packagingType: 'YOUR_PACKAGING',
      totalPackageCount: 1,
      requestedPackageLineItems: [{
        sequenceNumber: 1,
        groupPackageCount: 1,
        itemDescription: 'ClawPilot migration verification',
        dimensions: { length: 6, width: 6, height: 6, units: 'IN' },
        weight: { units: 'LB', value: 1 },
      }],
    },
  }
}

function assertCarrierProbeResponse(provider, payload) {
  if (provider === 'ups_rest') {
    const shipments = payload?.RateResponse?.RatedShipment
    if (!(Array.isArray(shipments) ? shipments.length : shipments && typeof shipments === 'object')) {
      throw safeProviderError(provider, 'read-only shipper account rate probe')
    }
    return
  }
  const replies = payload?.output?.rateReplyDetails
  if (!(Array.isArray(replies) && replies.length)) {
    throw safeProviderError(provider, 'read-only shipper account rate probe')
  }
}

async function verifyCarrier(
  fetchImpl,
  provider,
  environment,
  credential,
  accountNumberInput,
  addressInput,
  endpoints,
) {
  if (!['ups_rest', 'fedex_rest'].includes(provider)) fail('Carrier provider is invalid')
  const clientId = boundedPrintableAscii(credential.clientId, 'Carrier client ID', 3, 512)
  const clientSecret = boundedPrintableAscii(
    credential.clientSecret,
    'Carrier client secret',
    8,
    4096,
  )
  const endpoint = endpoints[provider]?.[environment]
  if (!endpoint?.token || !endpoint?.rate) fail('Carrier validation endpoints are not compiled')
  const accountNumber = boundedPrintableAscii(
    accountNumberInput,
    'Carrier account number',
    4,
    128,
  )
  const address = normalizeCarrierAddress(addressInput)
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  let body
  if (provider === 'ups_rest') {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`
    body = new URLSearchParams({ grant_type: 'client_credentials' })
  } else {
    body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    })
  }
  const response = await fetchImpl(endpoint.token, {
    method: 'POST', headers, body, redirect: 'error', cache: 'no-store', credentials: 'omit',
  })
  const payload = await boundedJsonResponse(response, provider, 'credential validation', 64 * 1024)
  const accessToken = boundedPrintable(payload.access_token, 'Carrier access-token response', 8, 8192)
  const tokenType = boundedPrintable(payload.token_type || 'Bearer', 'Carrier token type', 3, 32)
  if (tokenType.toLowerCase() !== 'bearer') fail('Carrier returned an unsupported token type')
  const probeBody = carrierProbeBody(provider, accountNumber, address)
  const requestHash = digest({
    provider,
    environment,
    addressFingerprint: carrierAddressFingerprint(address),
    accountNumberFingerprint: sha256(accountNumber),
    bodySha256: digest(probeBody),
  })
  const rateHeaders = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  }
  if (provider === 'ups_rest') {
    rateHeaders.transId = [
      requestHash.slice(0, 8), requestHash.slice(8, 12), requestHash.slice(12, 16),
      requestHash.slice(16, 20), requestHash.slice(20, 32),
    ].join('-')
    rateHeaders.transactionSrc = 'clawpilot'
  } else {
    rateHeaders['x-locale'] = 'en_US'
  }
  const rateResponse = await fetchImpl(endpoint.rate, {
    method: 'POST',
    headers: rateHeaders,
    body: JSON.stringify(probeBody),
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit',
  })
  const ratePayload = await boundedJsonResponse(
    rateResponse,
    provider,
    'read-only shipper account rate probe',
  )
  assertCarrierProbeResponse(provider, ratePayload)
  return {
    credentialIdentitySha256: digest({ provider, environment, clientId }),
    clientIdLastFour: clientId.slice(-4),
    accountNumberLastFour: accountNumber.slice(-4),
    addressFingerprint: carrierAddressFingerprint(address),
    operationalProbe: 'rate_read_only',
    providerMutationCount: 0,
  }
}

export function createProviderVerifier(runtime = {}) {
  const fetchImpl = runtime.fetchImpl || fetch
  const endpoints = providerEndpoints(runtime)
  return Object.freeze({
    async commerce(account, credential, configuration, targetGlobalId) {
      if (account.provider === 'shopify') {
        const verified = await verifyShopify(fetchImpl, credential, configuration)
        const desiredUri = callbackUri(targetGlobalId)
        const webhooks = await inspectShopifyWebhooks(fetchImpl, verified.runtime, desiredUri)
        return { ...verified, desiredUri, webhooks }
      }
      return verifyFaire(fetchImpl, credential, endpoints)
    },
    async carrier(account, credential, accountNumber, address) {
      return verifyCarrier(
        fetchImpl,
        account.provider,
        account.environment,
        credential,
        accountNumber,
        address,
        endpoints,
      )
    },
    async reconcileShopify(verification, expectedActions) {
      return reconcileShopifyWebhooks(
        fetchImpl,
        verification.runtime,
        verification.desiredUri,
        expectedActions,
      )
    },
  })
}

export function parseArguments(argv) {
  const args = [...argv]
  const command = args.shift()
  if (!['plan', 'apply', 'export-receipt'].includes(command)) {
    fail('Usage: rebind-migrated-production-integrations.mjs <plan|apply|export-receipt> [options]')
  }
  const values = {}
  while (args.length) {
    const flag = args.shift()
    if (!flag?.startsWith('--')) fail('Unexpected positional argument')
    if (!args.length || args[0].startsWith('--')) fail(`${flag} requires a value`)
    if (Object.hasOwn(values, flag)) fail(`${flag} may be supplied only once`)
    values[flag] = args.shift()
  }
  const required = ['--actor', '--manifest', '--mapping', '--source-account-global-id']
  if (command === 'plan') required.push('--output')
  else required.push('--plan', '--confirm-digest', '--receipt-output')
  for (const flag of required) if (!text(values[flag])) fail(`${flag} is required`)
  const allowed = new Set([
    ...required,
    '--history-mode',
    '--managed-rebind-secrets-fd',
    '--confirm-managed-source-authority',
  ])
  for (const flag of Object.keys(values)) if (!allowed.has(flag)) fail(`Unsupported option: ${flag}`)
  if (
    command === 'export-receipt'
    && (values['--managed-rebind-secrets-fd'] || values['--confirm-managed-source-authority'])
  ) {
    fail('Managed carrier secret input is not accepted when exporting committed evidence')
  }
  if (command !== 'plan' && values['--history-mode']) {
    fail('--history-mode is accepted only when planning a commerce provider rebind')
  }
  if (command !== 'plan' && values['--confirm-managed-source-authority']) {
    fail('--confirm-managed-source-authority is accepted only during plan review')
  }
  const managedFdRaw = text(values['--managed-rebind-secrets-fd'])
  if (managedFdRaw && !/^\d{1,3}$/u.test(managedFdRaw)) {
    fail('--managed-rebind-secrets-fd must be an inherited descriptor from 3 through 255')
  }
  const managedRebindSecretsFd = managedFdRaw ? Number(managedFdRaw) : undefined
  if (
    managedRebindSecretsFd !== undefined
    && (!Number.isSafeInteger(managedRebindSecretsFd)
      || managedRebindSecretsFd < 3 || managedRebindSecretsFd > 255)
  ) fail('--managed-rebind-secrets-fd must be an inherited descriptor from 3 through 255')
  const actor = text(values['--actor']).toLowerCase()
  if (!EMAIL.test(actor)) fail('--actor must be an email address')
  return {
    command,
    actor,
    manifest: values['--manifest'],
    mapping: values['--mapping'],
    selectedAccountGlobalId: text(values['--source-account-global-id']),
    historyMode: text(values['--history-mode']) || undefined,
    managedRebindSecretsFd,
    confirmManagedSourceAuthority: text(values['--confirm-managed-source-authority']) || undefined,
    output: values['--output'],
    plan: values['--plan'],
    confirmDigest: text(values['--confirm-digest']).toLowerCase(),
    receiptOutput: values['--receipt-output'],
  }
}

function loadPg() {
  const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
  return requireFromApp('pg')
}

function poolFor(connectionString, runtime) {
  if (runtime.poolFactory) return runtime.poolFactory(connectionString)
  const { Pool } = loadPg()
  return new Pool({
    connectionString,
    ssl: String(runtime.environment?.PGSSLMODE || process.env.PGSSLMODE || '').toLowerCase()
      === 'disable' ? undefined : { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
    application_name: SCRIPT_VERSION,
  })
}

async function databaseIdentity(client) {
  const result = await client.query(
    `SELECT value->>'id' AS database_identity
     FROM app_settings
     WHERE key = 'deployment.database.identity'
     LIMIT 1`,
  )
  return result.rows[0]?.database_identity || null
}

async function assertDatabaseBoundary(source, target) {
  const [sourceIdentity, targetIdentity] = await Promise.all([
    databaseIdentity(source),
    databaseIdentity(target),
  ])
  if (sourceIdentity !== SOURCE_DATABASE_IDENTITY) {
    fail('SOURCE_DATABASE_URL is not the compiled ClawPilot DEV database')
  }
  if (targetIdentity !== TARGET_DATABASE_IDENTITY) {
    fail('TARGET_DATABASE_URL is not the compiled ClawPilot PROD database')
  }
  if (sourceIdentity === targetIdentity) fail('Source and target database identities must differ')
}

async function assertTargetDatabaseBoundary(target) {
  if (await databaseIdentity(target) !== TARGET_DATABASE_IDENTITY) {
    fail('TARGET_DATABASE_URL is not the compiled ClawPilot PROD database')
  }
}

function selectedProviderScope(input) {
  const globalId = text(input.selectedAccountGlobalId)
  const matches = []
  for (const workspace of input.workspaces || WORKSPACES) {
    for (const account of workspace.accounts) {
      if (account.sourceGlobalId === globalId) matches.push({ workspace, account })
    }
  }
  if (matches.length !== 1) {
    fail('Exactly one compiled source provider Global ID must be selected')
  }
  return matches[0]
}

function migrationWorkspace(manifest, workspace) {
  const selected = manifest.workspaces?.filter((candidate) => candidate?.key === workspace.key) || []
  if (selected.length !== 1) fail(`${workspace.key} is missing from the approved migration manifest`)
  return selected[0]
}

function mappingWorkspace(mapping, workspace) {
  const selected = mapping.results?.filter((candidate) => candidate?.key === workspace.key) || []
  if (selected.length !== 1) fail(`${workspace.key} is missing from the migration mapping receipt`)
  return selected[0]
}

function assertMigrationArtifacts(manifest, mapping, bindings, actor, workspaces = WORKSPACES) {
  if (
    manifest.format !== MIGRATION_MANIFEST_FORMAT
    || manifest.scriptVersion !== MIGRATION_SCRIPT_VERSION
    || manifest.manifestDigest !== manifestDigest(manifest)
    || !manifest.applyReady
    || manifest.actor !== actor
  ) fail('Migration manifest is not the exact approved apply-ready artifact')
  if (
    manifest.sourceDatabase?.database_identity !== SOURCE_DATABASE_IDENTITY
    || manifest.targetDatabase?.database_identity !== TARGET_DATABASE_IDENTITY
    || manifest.sourceDatabase?.endpoint_sha256 !== bindings.source
    || manifest.targetDatabase?.endpoint_sha256 !== bindings.target
  ) fail('Migration manifest database boundary changed')
  if (
    mapping.format !== MIGRATION_MAPPING_FORMAT
    || mapping.scriptVersion !== MIGRATION_SCRIPT_VERSION
    || mapping.manifestDigest !== manifest.manifestDigest
    || mapping.sourceDatabaseIdentity !== SOURCE_DATABASE_IDENTITY
    || mapping.targetDatabaseIdentity !== TARGET_DATABASE_IDENTITY
    || mapping.sourceEndpointSha256 !== bindings.source
    || mapping.targetEndpointSha256 !== bindings.target
  ) fail('Migration mapping artifact does not match the approved manifest')
  if (manifest.workspaces?.length !== workspaces.length || mapping.results?.length !== workspaces.length) {
    fail('Migration artifacts do not contain the exact workspace allowlist')
  }
  const targetIntegrationIds = new Set()
  const targetGlobalIds = new Set()
  for (const workspace of workspaces) {
    const plan = migrationWorkspace(manifest, workspace)
    const result = mappingWorkspace(mapping, workspace)
    if (
      plan.source?.organizationId !== workspace.sourceOrganizationId
      || plan.source?.organizationReference !== workspace.sourceOrganizationReference
      || plan.target?.organizationId !== workspace.targetOrganizationId
      || plan.target?.organizationReference !== workspace.targetOrganizationReference
      || result.receiptIdentityDigest !== receiptIdentityDigestFromMappingResult(result)
    ) fail(`${workspace.key} migration artifact identity is invalid`)
    if (!plan.ready || plan.accounts?.length !== workspace.accounts.length) {
      fail(`${workspace.key} migration plan is not ready for the exact provider allowlist`)
    }
    for (const account of workspace.accounts) {
      const accountPlan = plan.accounts.find((candidate) => candidate.sourceId === account.sourceId)
      if (
        !accountPlan
        || accountPlan.sourceGlobalId !== account.sourceGlobalId
        || accountPlan.provider !== account.provider
        || accountPlan.integrationType !== account.integrationType
        || accountPlan.environment !== account.environment
        || accountPlan.reconnectEligible !== true
      ) fail(`${workspace.key} ${account.sourceGlobalId} is outside the approved provider plan`)
      if (
        account.integrationType === 'commerce'
        && accountPlan.externalAccountIdSha256 !== account.externalAccountIdSha256
      ) fail(`${account.sourceGlobalId} provider identity hash changed`)
      if (account.integrationType === 'carrier') {
        if (
          accountPlan.carrierAccount?.sourceId !== account.sourceCarrierAccountId
          || accountPlan.carrierAccount?.sourceGlobalId !== account.sourceCarrierAccountGlobalId
          || accountPlan.carrierAccount?.rebindMode !== account.rebindMode
        ) fail(`${account.sourceGlobalId} carrier account identity changed`)
      }
      const targetIdentity = result.mapping?.operations_integration_accounts?.[account.sourceId]
      if (
        !UUID.test(targetIdentity?.id || '')
        || !GLOBAL_ID.test(targetIdentity?.reference || '')
        || !String(targetIdentity.reference).startsWith('gia')
        || targetIntegrationIds.has(targetIdentity.id)
        || targetGlobalIds.has(targetIdentity.reference)
      ) fail(`${account.sourceGlobalId} target integration mapping is invalid`)
      targetIntegrationIds.add(targetIdentity.id)
      targetGlobalIds.add(targetIdentity.reference)
      if (account.integrationType === 'carrier') {
        const targetCarrier = result.mapping
          ?.operations_carrier_account_migration_placeholders?.[account.sourceCarrierAccountId]
        if (
          !UUID.test(targetCarrier?.id || '')
          || !GLOBAL_ID.test(targetCarrier?.reference || '')
          || !String(targetCarrier.reference).startsWith('gac')
        ) fail(`${account.sourceGlobalId} target carrier mapping is invalid`)
      }
    }
  }
}

function receiptIdentityDigestFromMappingResult(result) {
  if (!SHA256.test(result?.receiptIdentityDigest || '')) {
    fail('Migration mapping receipt identity digest is invalid')
  }
  return result.receiptIdentityDigest
}

async function assertCommittedMigrationReceipts(target, manifest, mapping, workspaces = WORKSPACES) {
  for (const workspace of workspaces) {
    const result = mappingWorkspace(mapping, workspace)
    const receipts = await target.query(
      `SELECT event_key, payload
       FROM audit_events
       WHERE organization_id = $1::uuid
         AND event_type = 'operations.commerce_workspace_migration.completed'
         AND payload->>'scriptVersion' = $2
         AND payload->>'manifestDigest' = $3
       ORDER BY created_at`,
      [workspace.targetOrganizationId, MIGRATION_SCRIPT_VERSION, manifest.manifestDigest],
    )
    if (receipts.rowCount !== 1) fail(`${workspace.key} lacks one exact committed migration receipt`)
    const payload = receipts.rows[0].payload
    if (
      payload?.receiptIdentityDigest !== result.receiptIdentityDigest
      || receiptIdentityDigest(payload) !== result.receiptIdentityDigest
      || canonicalJson(payload.mapping) !== canonicalJson(result.mapping)
      || payload.providerConnectionsCreated !== 0
      || payload.credentialRowsCopied !== 0
      || payload.carrierAccountSecretRowsCopied !== 0
      || payload.source?.databaseIdentity !== SOURCE_DATABASE_IDENTITY
      || payload.target?.databaseIdentity !== TARGET_DATABASE_IDENTITY
      || payload.source?.endpointSha256 !== manifest.sourceDatabase.endpoint_sha256
      || payload.target?.endpointSha256 !== manifest.targetDatabase.endpoint_sha256
    ) fail(`${workspace.key} committed migration receipt does not match its private mapping artifact`)
    if (
      !SHA256.test(payload.providerIdentityFenceDigest || '')
      || !SHA256.test(payload.sourceAuthorityDependencyDigest || '')
      || digest(payload.sourceAuthorityDependencies || [])
        !== payload.sourceAuthorityDependencyDigest
    ) fail(`${workspace.key} migration receipt lacks provider/source-authority evidence`)
  }
}

function targetIdentity(mapping, workspace, account) {
  const result = mappingWorkspace(mapping, workspace)
  const integration = result.mapping.operations_integration_accounts[account.sourceId]
  const carrier = account.integrationType === 'carrier'
    ? result.mapping.operations_carrier_account_migration_placeholders[
      account.sourceCarrierAccountId
    ]
    : null
  return {
    integrationId: integration.id,
    integrationGlobalId: integration.reference,
    carrierAccountId: carrier?.id || null,
    carrierAccountGlobalId: carrier?.reference || null,
  }
}

async function assertTargetSchema(client) {
  const requiredTables = [
    'operations_integration_accounts',
    'operations_commerce_credentials',
    'operations_commerce_order_history_policies',
    'operations_carrier_credentials',
    'operations_carrier_accounts',
    'operations_carrier_account_migration_placeholders',
    'operations_warehouses',
    'operations_commerce_migration_provider_identity_fences',
    'operations_commerce_store_sync_controls',
    'operations_commerce_sync_cursors',
    'operations_shopify_fulfillment_notification_policies',
    'audit_events',
  ]
  const result = await client.query(
    `SELECT name, to_regclass('public.' || name) IS NOT NULL AS present
     FROM unnest($1::text[]) AS required(name)
     ORDER BY name`,
    [requiredTables],
  )
  const missing = result.rows.filter((row) => !row.present).map((row) => row.name)
  if (missing.length) fail(`Target database lacks required migration schema: ${missing.join(', ')}`)
  const guard = await client.query(
    `SELECT trigger.tgenabled,
            procedure.proname,
            pg_get_triggerdef(trigger.oid) AS trigger_definition,
            pg_get_functiondef(procedure.oid) AS function_definition
     FROM pg_trigger trigger
     JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
     WHERE trigger.tgrelid = 'audit_events'::regclass
       AND trigger.tgname = 'protect_commerce_workspace_migration_receipt_write'
       AND trigger.tgisinternal = false`,
  )
  const receiptGuard = guard.rows[0]
  if (
    guard.rowCount !== 1
    || !['O', 'A'].includes(receiptGuard.tgenabled)
    || receiptGuard.proname !== 'protect_commerce_workspace_migration_receipt'
    || !/BEFORE (?:UPDATE OR DELETE|DELETE OR UPDATE)/u.test(receiptGuard.trigger_definition || '')
    || !String(receiptGuard.function_definition || '').includes(
      'operations.migrated_provider_rebind.completed',
    )
    || !String(receiptGuard.function_definition || '').includes(
      'migrated-provider-rebind:migrated-production-provider-rebind-v1:',
    )
  ) fail('Target database lacks the immutable provider rebind receipt guard')
  const historyGuardResult = await client.query(
    `SELECT trigger.tgenabled,
            procedure.proname,
            pg_get_triggerdef(trigger.oid) AS trigger_definition,
            pg_get_functiondef(procedure.oid) AS function_definition
     FROM pg_trigger trigger
     JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
     WHERE trigger.tgrelid = 'operations_commerce_order_history_policies'::regclass
       AND trigger.tgname = 'commerce_order_history_policy_guard'
       AND trigger.tgisinternal = false`,
  )
  const historyGuard = historyGuardResult.rows[0]
  const historyTrigger = String(historyGuard?.trigger_definition || '')
  const historyFunction = String(historyGuard?.function_definition || '')
  if (
    historyGuardResult.rowCount !== 1
    || !['O', 'A'].includes(historyGuard.tgenabled)
    || historyGuard.proname !== 'protect_commerce_order_history_policy'
    || !/BEFORE\s+(?=[^\n]*INSERT)(?=[^\n]*UPDATE)(?=[^\n]*DELETE)/u.test(historyTrigger)
    || !historyFunction.includes("IF TG_OP <> 'INSERT' THEN")
    || !historyFunction.includes('commerce order history policy is immutable')
  ) fail('Target database lacks the immutable commerce order-history policy guard')
}

async function loadCommerceSource(source, workspace, account) {
  const result = await source.query(
    `SELECT integration.id::text, integration.global_id, integration.provider,
            integration.integration_type, integration.environment,
            integration.external_account_id, integration.status,
            integration.configuration,
            integration.commerce_credential_generation,
            credential.auth_mode, credential.credential_ciphertext,
            credential.credential_iv, credential.credential_tag,
            credential.credential_version,
            credential.credential_identifier_last_four,
            credential.verification_status
     FROM operations_integration_accounts integration
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = integration.organization_id
      AND credential.integration_account_id = integration.id
     WHERE integration.organization_id = $1::uuid
       AND integration.id = $2::uuid`,
    [workspace.sourceOrganizationId, account.sourceId],
  )
  if (result.rowCount !== 1) fail(`${account.sourceGlobalId} source credential is unavailable`)
  const row = result.rows[0]
  if (
    row.global_id !== account.sourceGlobalId || row.provider !== account.provider
    || row.integration_type !== 'commerce' || row.environment !== account.environment
    || row.status !== 'active' || row.verification_status !== 'verified'
    || Number(row.commerce_credential_generation) !== Number(row.credential_version)
    || sha256(row.external_account_id) !== account.externalAccountIdSha256
  ) fail(`${account.sourceGlobalId} source commerce identity changed`)
  return row
}

async function loadDirectCarrierSource(source, workspace, account) {
  const result = await source.query(
    `SELECT integration.id::text, integration.global_id, integration.provider,
            integration.integration_type, integration.environment,
            integration.status, integration.configuration,
            credential.credential_ciphertext, credential.credential_iv,
            credential.credential_tag, credential.credential_version,
            credential.client_id_last_four, credential.verification_status,
            carrier.id::text AS carrier_account_id,
            carrier.global_id AS carrier_account_global_id,
            carrier.display_name, carrier.sender_name,
            carrier.account_number_ciphertext, carrier.account_number_iv,
            carrier.account_number_tag, carrier.encryption_version,
            carrier.account_number_last_four,
            carrier.account_number_fingerprint,
            carrier.registered_address,
            carrier.registered_address_fingerprint,
            carrier.address_verification, carrier.allow_sender_billing,
            carrier.allow_recipient_billing, carrier.allow_third_party_billing,
            carrier.status AS carrier_account_status
     FROM operations_integration_accounts integration
     JOIN operations_carrier_credentials credential
       ON credential.organization_id = integration.organization_id
      AND credential.integration_account_id = integration.id
     JOIN operations_carrier_accounts carrier
       ON carrier.organization_id = integration.organization_id
      AND carrier.integration_account_id = integration.id
      AND carrier.id = $3::uuid
     WHERE integration.organization_id = $1::uuid
       AND integration.id = $2::uuid`,
    [workspace.sourceOrganizationId, account.sourceId, account.sourceCarrierAccountId],
  )
  if (result.rowCount !== 1) fail(`${account.sourceGlobalId} direct carrier source is unavailable`)
  const row = result.rows[0]
  if (
    row.global_id !== account.sourceGlobalId
    || row.carrier_account_global_id !== account.sourceCarrierAccountGlobalId
    || row.provider !== account.provider || row.integration_type !== 'carrier'
    || row.environment !== account.environment || row.status !== 'active'
    || row.verification_status !== 'verified' || row.carrier_account_status !== 'active'
    || row.account_number_fingerprint !== account.sourceAccountNumberFingerprint
    || row.registered_address_fingerprint !== account.sourceAddressFingerprint
    || !['operator_attested', 'provider_verified'].includes(row.address_verification)
    || row.allow_sender_billing !== true
    || carrierAddressFingerprint(row.registered_address) !== account.sourceAddressFingerprint
  ) fail(`${account.sourceGlobalId} direct carrier identity changed`)
  return row
}

async function loadTargetAuthority(target, account) {
  const result = await target.query(
    `SELECT authority.id::text AS organization_id,
            authority.reference_code AS organization_reference,
            integration.id::text, integration.global_id, integration.provider,
            integration.integration_type, integration.environment,
            integration.status, integration.configuration,
            credential.client_id_last_four, credential.verification_status,
            carrier.id::text AS carrier_account_id,
            carrier.global_id AS carrier_account_global_id,
            carrier.display_name, carrier.sender_name,
            carrier.account_number_last_four,
            carrier.account_number_fingerprint,
            carrier.registered_address,
            carrier.registered_address_fingerprint,
            carrier.address_verification, carrier.allow_sender_billing,
            carrier.allow_recipient_billing, carrier.allow_third_party_billing,
            carrier.status AS carrier_account_status
     FROM workspace_organizations authority
     JOIN operations_integration_accounts integration
       ON integration.organization_id = authority.id
     JOIN operations_carrier_credentials credential
       ON credential.organization_id = integration.organization_id
      AND credential.integration_account_id = integration.id
     JOIN operations_carrier_accounts carrier
       ON carrier.organization_id = integration.organization_id
      AND carrier.integration_account_id = integration.id
     WHERE authority.reference_code = $1
       AND integration.global_id = $2
       AND carrier.global_id = $3`,
    [
      AG_AUTHORITY_ORGANIZATION_REFERENCE,
      account.authorityIntegrationGlobalId,
      account.authorityCarrierAccountGlobalId,
    ],
  )
  if (result.rowCount !== 1) fail(`${account.sourceGlobalId} production source authority is unavailable`)
  const row = result.rows[0]
  if (
    row.organization_reference !== AG_AUTHORITY_ORGANIZATION_REFERENCE
    || row.global_id !== account.authorityIntegrationGlobalId
    || row.carrier_account_global_id !== account.authorityCarrierAccountGlobalId
    || row.provider !== account.provider || row.integration_type !== 'carrier'
    || row.environment !== account.environment || row.status !== 'active'
    || row.verification_status !== 'verified' || row.carrier_account_status !== 'active'
    || row.account_number_last_four !== account.expectedLastFour
    || !['operator_attested', 'provider_verified'].includes(row.address_verification)
    || row.allow_sender_billing !== true
    || String(row.registered_address?.line1 || '').trim().toLowerCase()
      !== account.expectedAddressLine1.toLowerCase()
    || carrierAddressFingerprint(row.registered_address)
      !== row.registered_address_fingerprint
  ) fail(`${account.sourceGlobalId} production source authority identity changed`)
  return row
}

function historyPolicyEvidence(row, account, expectedActor) {
  const mode = text(row.history_mode)
  const frozen = new Date(row.frozen_at)
  const floor = row.ingestion_floor === null || row.ingestion_floor === undefined
    ? null
    : new Date(row.ingestion_floor)
  const actor = text(expectedActor).toLowerCase()
  if (
    row.history_provider !== account.provider
    || !COMMERCE_HISTORY_MODES.includes(mode)
    || (account.provider === 'shopify' && mode === 'provider_all')
    || Number.isNaN(frozen.getTime())
    || (mode === 'provider_all' && floor !== null)
    || (mode !== 'provider_all'
      && (floor === null || Number.isNaN(floor.getTime()) || floor > frozen))
  ) fail(`${account.sourceGlobalId} target order-history policy is missing or invalid`)
  const configuredBy = text(row.configured_by).toLowerCase()
  if (!EMAIL.test(actor) || !EMAIL.test(configuredBy) || configuredBy !== actor) {
    fail(`${account.sourceGlobalId} target order-history policy attribution is invalid`)
  }
  return {
    provider: row.history_provider,
    historyMode: mode,
    ingestionFloor: floor?.toISOString() || null,
    frozenAt: frozen.toISOString(),
    configuredBy,
  }
}

export function plannedHistoryPolicyEvidence({ account, actor, historyMode, frozenAt }) {
  const mode = text(historyMode)
  const frozen = new Date(frozenAt)
  const configuredBy = text(actor).toLowerCase()
  if (
    account?.integrationType !== 'commerce'
    || !['shopify', 'faire'].includes(account.provider)
    || !COMMERCE_HISTORY_MODES.includes(mode)
    || (account.provider === 'shopify' && mode === 'provider_all')
    || !EMAIL.test(configuredBy)
    || Number.isNaN(frozen.getTime())
    || frozen.toISOString() !== text(frozenAt)
  ) fail(`${account?.sourceGlobalId || 'Selected provider'} order-history choice is invalid`)
  const days = {
    new_orders_only: 0,
    last_7_days: 7,
    last_30_days: 30,
    last_60_days: 60,
  }
  const ingestionFloor = mode === 'provider_all'
    ? null
    : new Date(frozen.getTime() - days[mode] * 24 * 60 * 60 * 1000).toISOString()
  return historyPolicyEvidence({
    history_provider: account.provider,
    history_mode: mode,
    ingestion_floor: ingestionFloor,
    frozen_at: frozen.toISOString(),
    configured_by: configuredBy,
  }, account, configuredBy)
}

function targetConfigurationEvidence(configuration, account) {
  const value = safeJson(configuration)
  assertNoSecrets(value, `${account.sourceGlobalId} target placeholder configuration`)
  const evidence = { configurationSha256: digest(value) }
  if (account.integrationType === 'carrier') {
    const allowedCapabilities = Array.isArray(value.allowedCapabilities)
      ? value.allowedCapabilities.map((entry) => text(entry))
      : null
    const rebindRequestedCapabilities = Array.isArray(value.rebindRequestedCapabilities)
      ? value.rebindRequestedCapabilities.map((entry) => text(entry))
      : null
    if (
      allowedCapabilities === null || allowedCapabilities.some((entry) => !entry)
      || rebindRequestedCapabilities === null
      || rebindRequestedCapabilities.some((entry) => !entry)
    ) fail(`${account.sourceGlobalId} target carrier capability policy is invalid`)
    evidence.authorizationScope = text(value.authorizationScope) || null
    evidence.allowedCapabilities = allowedCapabilities
    evidence.rebindRequestedCapabilities = rebindRequestedCapabilities
  }
  return evidence
}

function storeSyncControlEvidence(row, account) {
  const revision = Number(row.sync_revision)
  const completeState = {
    desiredState: text(row.sync_desired_state),
    explicitChoice: row.sync_explicit_choice,
    revision,
    reason: text(row.sync_reason),
    createdBy: text(row.sync_created_by) || null,
    updatedBy: text(row.sync_updated_by) || null,
    createdAt: text(row.sync_created_at),
    updatedAt: text(row.sync_updated_at),
  }
  if (
    completeState.desiredState !== 'paused'
    || completeState.explicitChoice !== true
    || !Number.isSafeInteger(revision) || revision < 1
    || !completeState.reason || !completeState.createdAt || !completeState.updatedAt
  ) fail(`${account.sourceGlobalId} target Store sync control is not explicitly paused`)
  return {
    desiredState: completeState.desiredState,
    explicitChoice: completeState.explicitChoice,
    revision,
    stateSha256: digest(completeState),
  }
}

function carrierPlaceholderStateEvidence(row) {
  const completeState = {
    id: row.id,
    globalId: row.global_id,
    provider: row.provider,
    environment: row.environment,
    displayName: row.display_name,
    senderName: row.sender_name,
    sourceCarrierAccountId: row.source_carrier_account_id,
    sourceCarrierAccountGlobalId: row.source_carrier_account_global_id,
    sourceAccountNumberLastFour: row.source_account_number_last_four,
    sourceAccountNumberFingerprint: row.source_account_number_fingerprint,
    sourceRegisteredAddressFingerprint: row.source_registered_address_fingerprint,
    rebindMode: row.rebind_mode,
    requiredSourceAuthorityOrganizationId: row.required_source_authority_organization_id,
    requiredSourceAuthorityIntegrationAccountId:
      row.required_source_authority_integration_account_id,
    requiredSourceAuthorityCarrierAccountId: row.required_source_authority_carrier_account_id,
    requiredSourceOrganizationReference: row.required_source_organization_reference,
    requiredSourceIntegrationGlobalId: row.required_source_integration_global_id,
    requiredSourceCarrierAccountGlobalId: row.required_source_carrier_account_global_id,
    state: row.state,
    targetAccountNumberFingerprint: row.target_account_number_fingerprint,
  }
  return {
    state: completeState.state,
    rebindMode: completeState.rebindMode,
    stateSha256: digest(completeState),
  }
}

export function managedRebindMaterialDigest(material) {
  const copy = structuredClone(material)
  delete copy.materialDigest
  return digest(copy)
}

export function managedSourceAuthorityApprovalToken(account) {
  if (
    account?.integrationType !== 'carrier'
    || account.rebindMode !== 'source_authority'
    || !GLOBAL_ID.test(account.sourceGlobalId || '')
    || !GLOBAL_ID.test(account.authorityIntegrationGlobalId || '')
    || !GLOBAL_ID.test(account.authorityCarrierAccountGlobalId || '')
    || !/^\d{4}$/u.test(account.expectedLastFour || '')
  ) fail('Managed carrier source-authority approval binding is invalid')
  return [
    'approve',
    account.sourceGlobalId,
    AG_AUTHORITY_ORGANIZATION_REFERENCE,
    account.authorityIntegrationGlobalId,
    account.authorityCarrierAccountGlobalId,
    `*${account.expectedLastFour}`,
  ].join(':')
}

export function buildManagedRebindMaterial({
  actor,
  manifest,
  mapping,
  bindings,
  workspace,
  account,
  secretInput,
  approvalToken,
}) {
  if (text(approvalToken) !== managedSourceAuthorityApprovalToken(account)) {
    fail(`${account?.sourceGlobalId || 'Selected provider'} source-authority approval changed`)
  }
  const configuredBy = text(actor).toLowerCase()
  if (!EMAIL.test(configuredBy)) fail('Managed carrier reauthentication actor is invalid')
  assertExactObjectKeys(
    secretInput,
    ['clientId', 'clientSecret', 'accountNumber'],
    'Managed carrier secret input',
  )
  const clientId = boundedPrintableAscii(
    secretInput.clientId,
    'Managed carrier client ID',
    3,
    512,
  )
  const clientSecret = boundedPrintableAscii(
    secretInput.clientSecret,
    'Managed carrier client secret',
    8,
    4096,
  )
  const accountNumber = boundedPrintableAscii(
    secretInput.accountNumber,
    'Managed carrier account number',
    4,
    128,
  )
  if (accountNumber.slice(-4) !== account.expectedLastFour) {
    fail(`${account.sourceGlobalId} managed carrier account identity changed`)
  }
  const identity = targetIdentity(mapping, workspace, account)
  const material = {
    format: MANAGED_REBIND_MATERIAL_FORMAT,
    actor: configuredBy,
    migrationManifestDigest: manifest.manifestDigest,
    migrationMappingDigest: digest(mapping),
    targetDatabaseIdentity: TARGET_DATABASE_IDENTITY,
    targetDatabaseEndpointSha256: bindings.target,
    targetOrganizationId: workspace.targetOrganizationId,
    targetIntegrationAccountId: identity.integrationId,
    targetIntegrationAccountGlobalId: identity.integrationGlobalId,
    targetCarrierAccountId: identity.carrierAccountId,
    targetCarrierAccountGlobalId: identity.carrierAccountGlobalId,
    sourceAccountGlobalId: account.sourceGlobalId,
    provider: account.provider,
    environment: account.environment,
    authority: {
      organizationReference: AG_AUTHORITY_ORGANIZATION_REFERENCE,
      integrationGlobalId: account.authorityIntegrationGlobalId,
      carrierAccountGlobalId: account.authorityCarrierAccountGlobalId,
    },
    approved: true,
    credential: { clientId, clientSecret },
    accountNumber,
  }
  material.materialDigest = managedRebindMaterialDigest(material)
  return material
}

function managedRebindMaterialFingerprint(targetKey, material) {
  return crypto.createHmac('sha256', derivedKey(targetKey))
    .update('clawpilot:managed-carrier-reauthentication-material:v1\0', 'utf8')
    .update(canonicalJson(material), 'utf8')
    .digest('hex')
}

function assertReviewedManagedMaterialCommitment(input, account) {
  if (account.rebindMode !== 'source_authority') return
  const material = input.managedRebindMaterial
  const reviewed = input.plan?.providers?.[0]
  if (
    !material || typeof material !== 'object' || Array.isArray(material)
    || material.materialDigest !== managedRebindMaterialDigest(material)
    || material.materialDigest !== reviewed?.approvalArtifactDigest
    || managedRebindMaterialFingerprint(input.targetKey, material)
      !== reviewed?.reauthenticationMaterialFingerprintSha256
  ) fail(`${account.sourceGlobalId} managed carrier input does not match the confirmed rebind plan`)
}

function managedRebindMaterial(input, workspace, account, authority, identity) {
  const material = input.managedRebindMaterial
  assertExactObjectKeys(material, [
    'format',
    'actor',
    'migrationManifestDigest',
    'migrationMappingDigest',
    'targetDatabaseIdentity',
    'targetDatabaseEndpointSha256',
    'targetOrganizationId',
    'targetIntegrationAccountId',
    'targetIntegrationAccountGlobalId',
    'targetCarrierAccountId',
    'targetCarrierAccountGlobalId',
    'sourceAccountGlobalId',
    'provider',
    'environment',
    'authority',
    'approved',
    'credential',
    'accountNumber',
    'materialDigest',
  ], 'Managed carrier reauthentication material')
  assertExactObjectKeys(material.authority, [
    'organizationReference',
    'integrationGlobalId',
    'carrierAccountGlobalId',
  ], 'Managed carrier source-authority binding')
  assertExactObjectKeys(material.credential, [
    'clientId',
    'clientSecret',
  ], 'Managed carrier reauthentication credential')
  if (
    material.format !== MANAGED_REBIND_MATERIAL_FORMAT
    || material.actor !== input.actor
    || material.migrationManifestDigest !== input.manifest.manifestDigest
    || material.migrationMappingDigest !== digest(input.mapping)
    || material.targetDatabaseIdentity !== TARGET_DATABASE_IDENTITY
    || material.targetDatabaseEndpointSha256 !== input.bindings.target
    || material.targetOrganizationId !== workspace.targetOrganizationId
    || material.targetIntegrationAccountId !== identity.integrationId
    || material.targetIntegrationAccountGlobalId !== identity.integrationGlobalId
    || material.targetCarrierAccountId !== identity.carrierAccountId
    || material.targetCarrierAccountGlobalId !== identity.carrierAccountGlobalId
    || material.sourceAccountGlobalId !== account.sourceGlobalId
    || material.provider !== account.provider
    || material.environment !== account.environment
    || material.authority.organizationReference !== AG_AUTHORITY_ORGANIZATION_REFERENCE
    || material.authority.integrationGlobalId !== account.authorityIntegrationGlobalId
    || material.authority.carrierAccountGlobalId !== account.authorityCarrierAccountGlobalId
    || material.approved !== true
    || !SHA256.test(material.materialDigest || '')
    || material.materialDigest !== managedRebindMaterialDigest(material)
  ) fail(`${account.sourceGlobalId} managed carrier reauthentication approval changed`)
  const clientId = boundedPrintableAscii(
    material.credential.clientId,
    'Managed carrier client ID',
    3,
    512,
  )
  const clientSecret = boundedPrintableAscii(
    material.credential.clientSecret,
    'Managed carrier client secret',
    8,
    4096,
  )
  const accountNumber = boundedPrintableAscii(
    material.accountNumber,
    'Managed carrier account number',
    4,
    128,
  )
  if (
    accountNumber.slice(-4) !== authority.account_number_last_four
    || accountNumber.slice(-4) !== account.expectedLastFour
    || carrierAccountFingerprint(
      input.targetKey,
      authority.organization_id,
      account.provider,
      account.environment,
      accountNumber,
    ) !== authority.account_number_fingerprint
  ) fail(`${account.sourceGlobalId} managed carrier shipper identity changed`)
  return {
    credential: { clientId, clientSecret, accountNumber: null },
    accountNumber,
    approvalArtifactDigest: material.materialDigest,
    reauthenticationMaterialFingerprintSha256: managedRebindMaterialFingerprint(
      input.targetKey,
      material,
    ),
  }
}

async function loadTargetPlaceholder(
  target,
  workspace,
  account,
  identity,
  bindings,
  plannedHistoryPolicy,
) {
  const result = await target.query(
    `SELECT integration.id::text, integration.global_id, integration.provider,
            integration.integration_type, integration.environment,
            integration.status, integration.external_account_id,
            integration.credential_reference,
            integration.commerce_credential_generation,
            integration.receipt_intake_enabled, integration.configuration,
            fence.source_database_identity::text,
            fence.source_database_endpoint_sha256,
            fence.target_database_endpoint_sha256,
            fence.source_account_global_id,
            fence.source_provider_identity_sha256,
            fence.expected_external_account_id_sha256,
            fence.reconnect_eligible, fence.verification_state,
            fence.verified_external_account_id_sha256,
            fence.verified_carrier_account_id::text,
            fence.verified_carrier_account_identity_sha256
     FROM operations_integration_accounts integration
     JOIN operations_commerce_migration_provider_identity_fences fence
       ON fence.organization_id = integration.organization_id
      AND fence.integration_account_id = integration.id
     WHERE integration.organization_id = $1::uuid
       AND integration.id = $2::uuid`,
    [workspace.targetOrganizationId, identity.integrationId],
  )
  if (result.rowCount !== 1) fail(`${account.sourceGlobalId} target provider fence is unavailable`)
  const row = result.rows[0]
  if (
    row.global_id !== identity.integrationGlobalId
    || row.provider !== account.provider || row.integration_type !== account.integrationType
    || row.environment !== account.environment
    || row.source_database_identity !== SOURCE_DATABASE_IDENTITY
    || row.source_database_endpoint_sha256 !== bindings.source
    || row.target_database_endpoint_sha256 !== bindings.target
    || row.source_account_global_id !== account.sourceGlobalId
    || row.reconnect_eligible !== true
  ) fail(`${account.sourceGlobalId} target provider identity fence changed`)
  const alreadyVerified = row.verification_state === 'verified'
  if (!alreadyVerified && (
    row.status !== 'disabled' || row.external_account_id !== null
    || row.credential_reference !== null
    || Number(row.commerce_credential_generation) !== 0
    || row.receipt_intake_enabled !== false
    || row.configuration?.migrationRequiresCredentialRebind !== true
    || row.configuration?.migrationRequiresProviderIdentityVerification !== true
  )) fail(`${account.sourceGlobalId} target placeholder is not fail-closed`)
  if (alreadyVerified) return row
  if (account.integrationType === 'commerce') {
    if (
      row.source_provider_identity_sha256 !== account.externalAccountIdSha256
      || row.expected_external_account_id_sha256 !== account.externalAccountIdSha256
    ) fail(`${account.sourceGlobalId} target commerce identity fence changed`)
    const control = await target.query(
      `SELECT control.desired_state AS sync_desired_state,
              control.explicit_choice AS sync_explicit_choice,
              control.revision AS sync_revision,
              control.reason AS sync_reason,
              control.created_by AS sync_created_by,
              control.updated_by AS sync_updated_by,
              control.created_at::text AS sync_created_at,
              control.updated_at::text AS sync_updated_at
       FROM operations_commerce_store_sync_controls control
       WHERE control.organization_id = $1::uuid
         AND control.integration_account_id = $2::uuid`,
      [workspace.targetOrganizationId, identity.integrationId],
    )
    if (control.rowCount !== 1) {
      fail(`${account.sourceGlobalId} requires one explicit Paused Store sync control`)
    }
    const policy = await target.query(
      `SELECT 1
       FROM operations_commerce_order_history_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [workspace.targetOrganizationId, identity.integrationId],
    )
    if (policy.rowCount !== 0) {
      fail(`${account.sourceGlobalId} target order-history policy must be absent before rebind`)
    }
    if (!plannedHistoryPolicy) {
      fail(`${account.sourceGlobalId} requires an explicitly reviewed order-history choice`)
    }
    row.historyPolicy = plannedHistoryPolicy
    row.storeSyncControl = storeSyncControlEvidence(control.rows[0], account)
  } else {
    const placeholder = await target.query(
      `SELECT id::text, global_id, provider, environment, display_name,
              sender_name, source_carrier_account_id::text,
              source_carrier_account_global_id,
              source_account_number_last_four,
              source_account_number_fingerprint,
              source_registered_address_fingerprint, rebind_mode,
              required_source_organization_reference,
              required_source_authority_organization_id::text,
              required_source_authority_integration_account_id::text,
              required_source_authority_carrier_account_id::text,
              required_source_integration_global_id,
              required_source_carrier_account_global_id,
              state, target_account_number_fingerprint
       FROM operations_carrier_account_migration_placeholders
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [workspace.targetOrganizationId, identity.integrationId],
    )
    if (placeholder.rowCount !== 1) fail(`${account.sourceGlobalId} carrier placeholder is unavailable`)
    const carrier = placeholder.rows[0]
    if (
      carrier.id !== identity.carrierAccountId
      || carrier.global_id !== identity.carrierAccountGlobalId
      || carrier.provider !== account.provider || carrier.environment !== account.environment
      || carrier.source_carrier_account_id !== account.sourceCarrierAccountId
      || carrier.source_carrier_account_global_id !== account.sourceCarrierAccountGlobalId
      || carrier.rebind_mode !== account.rebindMode
    ) fail(`${account.sourceGlobalId} carrier placeholder identity changed`)
    if (account.rebindMode === 'direct_credential' && (
      carrier.source_account_number_fingerprint !== account.sourceAccountNumberFingerprint
      || carrier.source_registered_address_fingerprint !== account.sourceAddressFingerprint
    )) fail(`${account.sourceGlobalId} direct carrier placeholder fingerprint changed`)
    if (account.rebindMode === 'source_authority' && (
      carrier.required_source_organization_reference !== AG_AUTHORITY_ORGANIZATION_REFERENCE
      || carrier.required_source_integration_global_id !== account.authorityIntegrationGlobalId
      || carrier.required_source_carrier_account_global_id !== account.authorityCarrierAccountGlobalId
    )) fail(`${account.sourceGlobalId} source-authority placeholder changed`)
    if (account.rebindMode === 'source_authority') {
      const warehouseGlobalId = row.configuration?.senderOriginWarehouseGlobalId
      if (!GLOBAL_ID.test(warehouseGlobalId || '') || !warehouseGlobalId.startsWith('gwh')) {
        fail(`${account.sourceGlobalId} target sender-origin warehouse binding is invalid`)
      }
      const warehouse = await target.query(
        `SELECT id::text, global_id, address, status
         FROM operations_warehouses
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [workspace.targetOrganizationId, warehouseGlobalId],
      )
      if (warehouse.rowCount !== 1 || warehouse.rows[0].status !== 'active') {
        fail(`${account.sourceGlobalId} target sender-origin warehouse is unavailable`)
      }
      row.targetOriginWarehouse = warehouse.rows[0]
    }
    row.carrierPlaceholder = carrier
    row.carrierPlaceholderState = carrierPlaceholderStateEvidence(carrier)
  }
  if (!alreadyVerified) {
    row.targetConfiguration = targetConfigurationEvidence(row.configuration, account)
  }
  return row
}

function bytea(value, label) {
  if (!Buffer.isBuffer(value)) fail(`${label} is not binary ciphertext`)
  return value
}

function encodedCiphertext(value, label) {
  const raw = boundedPrintable(value, label, 1, 65536)
  const decoded = Buffer.from(raw, 'base64')
  if (!decoded.length || decoded.toString('base64').replace(/=+$/u, '') !== raw.replace(/=+$/u, '')) {
    fail(`${label} is not canonical base64 ciphertext`)
  }
  return decoded
}

function decryptedCommerceCredential(row, sourceKey) {
  const plaintext = decryptAesGcm({
    ciphertext: bytea(row.credential_ciphertext, 'Commerce credential ciphertext'),
    iv: bytea(row.credential_iv, 'Commerce credential IV'),
    tag: bytea(row.credential_tag, 'Commerce credential tag'),
  }, sourceKey, commerceAad(
    row.organization_id,
    row.provider,
    row.environment,
    row.external_account_id,
  ), 'Commerce credential')
  const credential = parseCredentialJson(plaintext, 'Commerce credential')
  if (
    credential.provider !== row.provider || credential.authMode !== row.auth_mode
  ) fail('Stored commerce credential metadata changed')
  return credential
}

function decryptedCarrierMaterial(row, key, organizationId) {
  const credential = parseCredentialJson(decryptAesGcm({
    ciphertext: bytea(row.credential_ciphertext, 'Carrier credential ciphertext'),
    iv: bytea(row.credential_iv, 'Carrier credential IV'),
    tag: bytea(row.credential_tag, 'Carrier credential tag'),
  }, key, carrierCredentialAad(
    organizationId,
    row.provider,
    row.environment,
  ), 'Carrier credential'), 'Carrier credential')
  const accountNumber = decryptAesGcm({
    ciphertext: encodedCiphertext(row.account_number_ciphertext, 'Carrier account ciphertext'),
    iv: encodedCiphertext(row.account_number_iv, 'Carrier account IV'),
    tag: encodedCiphertext(row.account_number_tag, 'Carrier account tag'),
  }, key, carrierAccountAad(
    organizationId,
    row.provider,
    row.environment,
    row.carrier_account_global_id,
  ), 'Carrier account number').toString('utf8').trim()
  if (
    !credential || typeof credential !== 'object'
    || typeof credential.clientId !== 'string'
    || typeof credential.clientSecret !== 'string'
    || !accountNumber || accountNumber.slice(-4) !== row.account_number_last_four
    || carrierAccountFingerprint(
      key,
      organizationId,
      row.provider,
      row.environment,
      accountNumber,
    ) !== row.account_number_fingerprint
  ) fail('Carrier credential or shipper account identity changed')
  return { credential, accountNumber }
}

function withoutMigrationFlags(configuration) {
  const next = structuredClone(safeJson(configuration))
  for (const key of [
    'migrationRequiresCredentialRebind',
    'migrationRequiresProviderIdentityVerification',
    'migrationRequiresSourceAuthorityRebind',
    'rebindRequestedCapabilities',
  ]) delete next[key]
  return next
}

function commerceTargetConfiguration(placeholder, account, sourceRow, verification) {
  const configuration = withoutMigrationFlags(placeholder.configuration)
  configuration.accountName = verification.accountName
  configuration.providerAccountId = verification.externalAccountId
  configuration.authMode = sourceRow.auth_mode
  configuration.domainWorkersActivated = false
  if (account.provider === 'shopify') {
    configuration.classification = configuration.classification || 'commerce_sales_channel'
    configuration.shopDomain = verification.shopDomain
    configuration.apiVersion = SHOPIFY_API_VERSION
    configuration.adapterVersion = configuration.adapterVersion || 'shopify-admin-graphql-2026-07-v1'
    configuration.grantedScopes = verification.grantedScopes
    configuration.acceptedReceiptTopics = [...SHOPIFY_ORDER_TOPICS]
    configuration.webhookSecretVerified = false
    configuration.migratedProductionCallbackUriSha256 = sha256(verification.desiredUri)
  } else {
    configuration.classification = configuration.classification
      || 'b2b_wholesale_marketplace_sales_channel'
    configuration.apiVersion = 'external-api-v2'
    configuration.adapterVersion = configuration.adapterVersion || 'faire-external-api-v2-v1'
    configuration.webhooksAvailable = false
    configuration.sandboxAvailable = false
  }
  assertNoSecrets(configuration, 'Target commerce configuration')
  return configuration
}

function carrierTargetConfiguration(placeholder, account) {
  const configuration = withoutMigrationFlags(placeholder.configuration)
  const requested = Array.isArray(placeholder.configuration?.rebindRequestedCapabilities)
    ? placeholder.configuration.rebindRequestedCapabilities.map((value) => text(value)).filter(Boolean)
    : []
  if (!requested.length || new Set(requested).size !== requested.length) {
    fail(`${account.sourceGlobalId} approved carrier capabilities are invalid`)
  }
  configuration.allowedCapabilities = requested
  if (account.rebindMode === 'source_authority') {
    const expectedCapabilities = configuration.authorizationScope === 'sandbox_rating_only'
      ? ['sandbox_rate']
      : configuration.authorizationScope === 'sandbox_fulfillment_diagnostic'
        ? ['sandbox_rate', 'sandbox_label']
        : []
    if (
      configuration.managedBy !== AG_MANAGED_BY
      || configuration.credentialRevealAllowed !== false
      || canonicalJson(requested) !== canonicalJson(expectedCapabilities)
      || configuration.delegatedFromOrganizationReferenceCode
        !== AG_AUTHORITY_ORGANIZATION_REFERENCE
      || configuration.sourceIntegrationGlobalId !== account.authorityIntegrationGlobalId
      || configuration.sourceCarrierAccountGlobalId !== account.authorityCarrierAccountGlobalId
      || !GLOBAL_ID.test(configuration.senderOriginWarehouseGlobalId || '')
      || !String(configuration.senderOriginWarehouseGlobalId).startsWith('gwh')
    ) fail(`${account.sourceGlobalId} managed delegation policy changed`)
    configuration.migrationSourceAuthorityVerified = true
  }
  assertNoSecrets(configuration, 'Target carrier configuration')
  return configuration
}

function redactedProviderEvidence(
  account,
  verification,
  placeholder,
  identity,
  managedMaterial = null,
) {
  if (account.integrationType === 'commerce') {
    return {
      sourceAccountGlobalId: account.sourceGlobalId,
      targetAccountGlobalId: identity.integrationGlobalId,
      provider: account.provider,
      environment: account.environment,
      providerIdentitySha256: verification.identitySha256,
      credentialValidation: 'verified_read_only',
      accountOperationalValidation: verification.operationalProbe,
      targetPlaceholder: {
        configuration: placeholder.targetConfiguration,
        storeSyncControl: placeholder.storeSyncControl,
      },
      orderHistoryPolicy: placeholder.historyPolicy,
      callback: account.provider === 'shopify' ? {
        desiredUri: verification.desiredUri,
        desiredUriSha256: sha256(verification.desiredUri),
        actions: verification.webhooks.actions,
        observed: verification.webhooks.observed,
        providerWritesDuringPlan: 0,
      } : {
        disposition: 'not_applicable_provider_has_no_documented_webhooks',
        providerWritesDuringPlan: 0,
      },
    }
  }
  return {
    sourceAccountGlobalId: account.sourceGlobalId,
    targetAccountGlobalId: identity.integrationGlobalId,
    targetCarrierAccountGlobalId: identity.carrierAccountGlobalId,
    provider: account.provider,
    environment: account.environment,
    credentialIdentitySha256: verification.credentialIdentitySha256,
    carrierIdentitySha256: placeholder.source_provider_identity_sha256,
    addressFingerprint: placeholder.carrierPlaceholder.source_registered_address_fingerprint,
    accountNumberLastFour: placeholder.carrierPlaceholder.source_account_number_last_four,
    rebindMode: account.rebindMode,
    targetPlaceholder: {
      configuration: placeholder.targetConfiguration,
      carrierAccount: placeholder.carrierPlaceholderState,
    },
    sourceAuthority: account.rebindMode === 'source_authority' ? {
      organizationReference: AG_AUTHORITY_ORGANIZATION_REFERENCE,
      integrationGlobalId: account.authorityIntegrationGlobalId,
      carrierAccountGlobalId: account.authorityCarrierAccountGlobalId,
      credentialSource: 'operator_supplied_target_reauthentication',
    } : null,
    approvalArtifactDigest: managedMaterial?.approvalArtifactDigest || null,
    reauthenticationMaterialFingerprintSha256:
      managedMaterial?.reauthenticationMaterialFingerprintSha256 || null,
    credentialValidation: 'verified_read_only',
    accountOperationalValidation: verification.operationalProbe,
    providerWritesDuringPlan: 0,
  }
}

async function collectValidatedMaterials(input) {
  const materials = []
  const selected = selectedProviderScope(input)
  if (
    selected.account.rebindMode !== 'source_authority'
    && input.managedRebindMaterial !== undefined
    && input.managedRebindMaterial !== null
  ) fail('Managed carrier reauthentication material is accepted only for a source-authority rebind')
  for (const workspace of input.workspaces || WORKSPACES) {
    for (const account of workspace.accounts) {
      if (workspace.key !== selected.workspace.key || account.sourceId !== selected.account.sourceId) {
        continue
      }
      const identity = targetIdentity(input.mapping, workspace, account)
      const placeholder = await loadTargetPlaceholder(
        input.target,
        workspace,
        account,
        identity,
        input.bindings,
        input.plannedHistoryPolicy,
      )
      if (placeholder.verification_state === 'verified') {
        fail(`${account.sourceGlobalId} is already rebound; export the committed rebind receipt instead`)
      }
      if (account.integrationType === 'commerce') {
        const sourceRow = await loadCommerceSource(input.source, workspace, account)
        sourceRow.organization_id = workspace.sourceOrganizationId
        const credential = decryptedCommerceCredential(sourceRow, input.sourceKey)
        const verification = await input.verifier.commerce(
          account,
          credential,
          sourceRow.configuration,
          identity.integrationGlobalId,
        )
        if (
          verification.identitySha256 !== account.externalAccountIdSha256
          || verification.externalAccountId !== sourceRow.external_account_id
          || verification.providerMutationCount !== 0
          || !String(verification.operationalProbe || '').endsWith('_read_only')
        ) fail(`${account.sourceGlobalId} provider returned a different account identity`)
        const targetPlaintext = Buffer.from(JSON.stringify(credential), 'utf8')
        const encrypted = encryptAesGcm(
          targetPlaintext,
          input.targetKey,
          commerceAad(
            workspace.targetOrganizationId,
            account.provider,
            account.environment,
            sourceRow.external_account_id,
          ),
        )
        const configuration = commerceTargetConfiguration(
          placeholder,
          account,
          sourceRow,
          verification,
        )
        materials.push({
          workspace,
          account,
          identity,
          placeholder,
          verification,
          redacted: redactedProviderEvidence(account, verification, placeholder, identity),
          secret: {
            credential,
            externalAccountId: sourceRow.external_account_id,
            authMode: sourceRow.auth_mode,
            encrypted,
            identifierLastFour: sourceRow.credential_identifier_last_four,
            configuration,
          },
        })
        continue
      }

      let sourceRow
      let decrypted
      if (account.rebindMode === 'source_authority') {
        sourceRow = await loadTargetAuthority(input.target, account)
        if (
          sourceRow.organization_id
            !== placeholder.carrierPlaceholder.required_source_authority_organization_id
          || sourceRow.id
            !== placeholder.carrierPlaceholder.required_source_authority_integration_account_id
          || sourceRow.carrier_account_id
            !== placeholder.carrierPlaceholder.required_source_authority_carrier_account_id
        ) fail(`${account.sourceGlobalId} production authority UUID binding changed`)
        decrypted = managedRebindMaterial(input, workspace, account, sourceRow, identity)
      } else {
        sourceRow = await loadDirectCarrierSource(input.source, workspace, account)
        decrypted = decryptedCarrierMaterial(
          sourceRow,
          input.sourceKey,
          workspace.sourceOrganizationId,
        )
      }
      const address = normalizeCarrierAddress(sourceRow.registered_address)
      const verification = await input.verifier.carrier(
        account,
        decrypted.credential,
        decrypted.accountNumber,
        address,
      )
      if (
        (account.rebindMode === 'direct_credential'
          && verification.clientIdLastFour !== sourceRow.client_id_last_four)
        || verification.clientIdLastFour
          !== String(decrypted.credential.clientId || '').slice(-4)
        || verification.accountNumberLastFour !== decrypted.accountNumber.slice(-4)
        || verification.addressFingerprint !== carrierAddressFingerprint(address)
        || verification.operationalProbe !== 'rate_read_only'
        || verification.providerMutationCount !== 0
      ) fail(`${account.sourceGlobalId} carrier credential identity changed`)
      const addressFingerprint = carrierAddressFingerprint(address)
      if (
        decrypted.accountNumber.slice(-4)
          !== placeholder.carrierPlaceholder.source_account_number_last_four
        || (account.rebindMode === 'direct_credential'
          && sourceRow.account_number_fingerprint
            !== placeholder.carrierPlaceholder.source_account_number_fingerprint)
        || addressFingerprint
          !== placeholder.carrierPlaceholder.source_registered_address_fingerprint
      ) fail(`${account.sourceGlobalId} carrier material does not match its migration placeholder`)
      if (
        account.rebindMode === 'source_authority'
        && carrierAddressFingerprint(placeholder.targetOriginWarehouse.address)
          !== placeholder.carrierPlaceholder.source_registered_address_fingerprint
      ) fail(`${account.sourceGlobalId} target sender origin does not match the verified shipper address`)
      const targetAccountFingerprint = carrierAccountFingerprint(
        input.targetKey,
        workspace.targetOrganizationId,
        account.provider,
        account.environment,
        decrypted.accountNumber,
      )
      const encryptedCredential = encryptAesGcm(
        Buffer.from(JSON.stringify(decrypted.credential), 'utf8'),
        input.targetKey,
        carrierCredentialAad(
          workspace.targetOrganizationId,
          account.provider,
          account.environment,
        ),
      )
      const encryptedAccountNumber = encryptAesGcm(
        Buffer.from(decrypted.accountNumber, 'utf8'),
        input.targetKey,
        carrierAccountAad(
          workspace.targetOrganizationId,
          account.provider,
          account.environment,
          identity.carrierAccountGlobalId,
        ),
      )
      const configuration = carrierTargetConfiguration(placeholder, account)
      materials.push({
        workspace,
        account,
        identity,
        placeholder,
        verification,
        redacted: redactedProviderEvidence(
          account,
          verification,
          placeholder,
          identity,
          account.rebindMode === 'source_authority' ? decrypted : null,
        ),
        secret: {
          credential: decrypted.credential,
          encryptedCredential,
          encryptedAccountNumber,
          accountNumber: decrypted.accountNumber,
          targetAccountFingerprint,
          registeredAddress: address,
          addressVerification: sourceRow.address_verification,
          configuration,
          displayName: placeholder.carrierPlaceholder.display_name,
          senderName: placeholder.carrierPlaceholder.sender_name,
          allowSenderBilling: sourceRow.allow_sender_billing,
          allowRecipientBilling: sourceRow.allow_recipient_billing,
          allowThirdPartyBilling: sourceRow.allow_third_party_billing,
        },
      })
    }
  }
  if (materials.length !== 1) fail('Exactly one selected provider must be validated per rebind plan')
  return materials
}

function redactedMaterialProjection(materials) {
  return materials.map((material) => material.redacted)
}

function buildPlanArtifact(input, materials, createdAt) {
  const workspaces = input.workspaces || WORKSPACES
  const artifact = {
    format: PLAN_FORMAT,
    scriptVersion: SCRIPT_VERSION,
    createdAt,
    actor: input.actor,
    selectedSourceAccountGlobalId: input.selectedAccountGlobalId,
    migrationManifestDigest: input.manifest.manifestDigest,
    migrationMappingDigest: digest(input.mapping),
    migrationReceiptDigests: workspaces.map((workspace) => ({
      key: workspace.key,
      receiptIdentityDigest: mappingWorkspace(input.mapping, workspace).receiptIdentityDigest,
    })),
    source: {
      railwayProjectId: RAILWAY_PROJECT_ID,
      railwayEnvironmentId: SOURCE_RAILWAY_ENVIRONMENT_ID,
      databaseIdentity: SOURCE_DATABASE_IDENTITY,
      endpointSha256: input.bindings.source,
    },
    target: {
      railwayProjectId: RAILWAY_PROJECT_ID,
      railwayEnvironmentId: TARGET_RAILWAY_ENVIRONMENT_ID,
      databaseIdentity: TARGET_DATABASE_IDENTITY,
      endpointSha256: input.bindings.target,
      publicOrigin: PRODUCTION_PUBLIC_ORIGIN,
    },
    exclusions: {
      mockProviders: true,
      sourceCursors: true,
      sourceWebhookState: true,
      sourceWebhookReceipts: true,
      sourceProviderAttempts: true,
      sourceOutbox: true,
      sourceOrders: true,
      episcsOrganization: true,
      episcsDevelopmentCarrierCredentials: true,
    },
    transaction: {
      isolation: 'serializable',
      targetAtomic: true,
      providerCount: 1,
      recovery: 'export-receipt-after-committed-write; otherwise rerun plan',
    },
    providers: redactedMaterialProjection(materials),
    applyReady: true,
  }
  assertNoSecrets(artifact, 'Rebind plan')
  artifact.planDigest = planDigest(artifact)
  return artifact
}

function assertPlanEnvelope(plan, input) {
  if (
    plan?.format !== PLAN_FORMAT
    || plan.scriptVersion !== SCRIPT_VERSION
    || plan.actor !== input.actor
    || plan.selectedSourceAccountGlobalId !== input.selectedAccountGlobalId
    || plan.migrationManifestDigest !== input.manifest.manifestDigest
    || plan.migrationMappingDigest !== digest(input.mapping)
    || plan.source?.railwayProjectId !== RAILWAY_PROJECT_ID
    || plan.target?.railwayProjectId !== RAILWAY_PROJECT_ID
    || plan.source?.railwayEnvironmentId !== SOURCE_RAILWAY_ENVIRONMENT_ID
    || plan.target?.railwayEnvironmentId !== TARGET_RAILWAY_ENVIRONMENT_ID
    || plan.source?.databaseIdentity !== SOURCE_DATABASE_IDENTITY
    || plan.target?.databaseIdentity !== TARGET_DATABASE_IDENTITY
    || plan.source?.endpointSha256 !== input.bindings.source
    || plan.target?.endpointSha256 !== input.bindings.target
    || plan.target?.publicOrigin !== PRODUCTION_PUBLIC_ORIGIN
    || plan.applyReady !== true
    || plan.planDigest !== planDigest(plan)
    || plan.planDigest !== input.confirmDigest
  ) fail('The reviewed rebind plan or explicit confirmation digest changed')
  const expectedReceiptDigests = (input.workspaces || WORKSPACES).map((workspace) => ({
    key: workspace.key,
    receiptIdentityDigest: mappingWorkspace(input.mapping, workspace).receiptIdentityDigest,
  }))
  if (
    canonicalJson(plan.migrationReceiptDigests) !== canonicalJson(expectedReceiptDigests)
    || plan.exclusions?.mockProviders !== true
    || plan.exclusions?.sourceCursors !== true
    || plan.exclusions?.sourceWebhookState !== true
    || plan.exclusions?.sourceWebhookReceipts !== true
    || plan.exclusions?.sourceProviderAttempts !== true
    || plan.exclusions?.sourceOutbox !== true
    || plan.exclusions?.sourceOrders !== true
    || plan.exclusions?.episcsOrganization !== true
    || plan.exclusions?.episcsDevelopmentCarrierCredentials !== true
    || plan.transaction?.isolation !== 'serializable'
    || plan.transaction?.targetAtomic !== true
    || plan.transaction?.providerCount !== 1
    || !Array.isArray(plan.providers)
    || plan.providers.length !== 1
    || plan.providers[0]?.sourceAccountGlobalId !== input.selectedAccountGlobalId
  ) fail('The reviewed rebind evidence no longer matches provider or migration state')
  assertNoSecrets(plan, 'Reviewed rebind plan')
}

function assertReviewedPlan(plan, input, materials) {
  assertPlanEnvelope(plan, input)
  if (canonicalJson(plan.providers) !== canonicalJson(redactedMaterialProjection(materials))) {
    fail('The reviewed rebind provider evidence no longer matches provider state')
  }
}

async function applyCommerceMaterial(client, material, actor) {
  const { workspace, account, identity, secret } = material
  const locked = await client.query(
    `SELECT account.status, account.external_account_id,
            account.credential_reference, account.commerce_credential_generation,
            account.receipt_intake_enabled, account.configuration,
            fence.verification_state,
            history.provider AS history_provider, history.history_mode,
            history.ingestion_floor, history.frozen_at, history.configured_by,
            control.desired_state AS sync_desired_state,
            control.explicit_choice AS sync_explicit_choice,
            control.revision AS sync_revision,
            control.reason AS sync_reason,
            control.created_by AS sync_created_by,
            control.updated_by AS sync_updated_by,
            control.created_at::text AS sync_created_at,
            control.updated_at::text AS sync_updated_at
     FROM operations_integration_accounts account
     JOIN operations_commerce_migration_provider_identity_fences fence
       ON fence.organization_id = account.organization_id
      AND fence.integration_account_id = account.id
     JOIN operations_commerce_order_history_policies history
       ON history.organization_id = account.organization_id
      AND history.integration_account_id = account.id
     JOIN operations_commerce_store_sync_controls control
       ON control.organization_id = account.organization_id
      AND control.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid AND account.id = $2::uuid
     FOR UPDATE OF account, fence, history, control`,
    [workspace.targetOrganizationId, identity.integrationId],
  )
  const state = locked.rows[0]
  if (
    locked.rowCount !== 1 || state.status !== 'disabled'
    || state.external_account_id !== null || state.credential_reference !== null
    || Number(state.commerce_credential_generation) !== 0
    || state.receipt_intake_enabled !== false
    || state.verification_state !== 'awaiting_provider_identity'
    || canonicalJson(targetConfigurationEvidence(state.configuration, account))
      !== canonicalJson(material.placeholder.targetConfiguration)
    || canonicalJson(storeSyncControlEvidence(state, account))
      !== canonicalJson(material.placeholder.storeSyncControl)
  ) fail(`${account.sourceGlobalId} commerce placeholder changed before commit`)
  if (
    canonicalJson(historyPolicyEvidence(state, account, actor))
      !== canonicalJson(material.placeholder.historyPolicy)
  ) fail(`${account.sourceGlobalId} frozen target order-history policy changed before commit`)

  const callbackReady = account.provider === 'shopify'
    ? material.verification.webhooks.ready === true
    : false
  if (account.provider === 'shopify' && !callbackReady) {
    fail(`${account.sourceGlobalId} production callback was not verified before commit`)
  }
  await client.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id, auth_mode,
       credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, last_error_code,
       webhook_verification_status, webhook_verified_at,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, 1, $8,
       'verified', clock_timestamp(), NULL,
       $9, CASE WHEN $9 = 'verified' THEN clock_timestamp() ELSE NULL END,
       $10, $10
     )`,
    [
      workspace.targetOrganizationId,
      identity.integrationId,
      secret.externalAccountId,
      secret.authMode,
      secret.encrypted.ciphertext,
      secret.encrypted.iv,
      secret.encrypted.tag,
      secret.identifierLastFour,
      account.provider === 'shopify' ? 'unverified' : 'not_applicable',
      actor,
    ],
  )
  const fence = await client.query(
    `UPDATE operations_commerce_migration_provider_identity_fences
     SET verification_state = 'verified',
         verified_external_account_id_sha256 = $3,
         verified_by = $4, verified_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND integration_type = 'commerce'
       AND verification_state = 'awaiting_provider_identity'
       AND expected_external_account_id_sha256 = $3
     RETURNING verification_state`,
    [
      workspace.targetOrganizationId,
      identity.integrationId,
      account.externalAccountIdSha256,
      actor,
    ],
  )
  if (fence.rowCount !== 1) fail(`${account.sourceGlobalId} commerce identity fence did not verify`)
  const updated = await client.query(
    `UPDATE operations_integration_accounts
     SET external_account_id = $3,
         status = 'active',
         configuration = $4::jsonb,
         credential_reference = $5,
         commerce_credential_generation = 1,
         receipt_intake_enabled = $6,
         updated_by = $7,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid
       AND status = 'disabled' AND external_account_id IS NULL
       AND credential_reference IS NULL
       AND commerce_credential_generation = 0
       AND receipt_intake_enabled = false
     RETURNING global_id`,
    [
      workspace.targetOrganizationId,
      identity.integrationId,
      secret.externalAccountId,
      JSON.stringify(secret.configuration),
      `commerce-credential:${identity.integrationId}:v1`,
      account.provider === 'shopify',
      actor,
    ],
  )
  if (updated.rowCount !== 1 || updated.rows[0].global_id !== identity.integrationGlobalId) {
    fail(`${account.sourceGlobalId} commerce placeholder did not activate`)
  }
  for (const resource of COMMERCE_SYNC_RESOURCES[account.provider] || []) {
    await client.query(
      `INSERT INTO operations_commerce_sync_cursors (
         organization_id, integration_account_id, resource,
         provider_cursor, high_watermark, reconciliation_status,
         records_seen, records_applied, records_held, consecutive_failures,
         last_error_code, last_started_at, last_completed_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, NULL, NULL, 'idle',
         0, 0, 0, 0, NULL, NULL, NULL, clock_timestamp()
       )`,
      [workspace.targetOrganizationId, identity.integrationId, resource],
    )
  }
  const control = await client.query(
    `UPDATE operations_commerce_store_sync_controls
     SET desired_state = 'running', explicit_choice = true,
         revision = revision + 1,
         reason = 'Provider identity reverified after approved production migration',
         updated_by = $3, updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid
       AND desired_state = 'paused' AND explicit_choice = true
     RETURNING revision`,
    [workspace.targetOrganizationId, identity.integrationId, actor],
  )
  if (control.rowCount !== 1) fail(`${account.sourceGlobalId} Store sync control was not released`)
  if (account.provider === 'shopify') {
    await client.query(
      `INSERT INTO operations_shopify_fulfillment_notification_policies (
         organization_id, integration_account_id, policy_version,
         notify_customer_default, revision, change_reason, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify-fulfillment-notification-v1',
         false, 1, 'Safe default established during approved production rebind', $3, $3
       ) ON CONFLICT (organization_id, integration_account_id) DO NOTHING`,
      [workspace.targetOrganizationId, identity.integrationId, actor],
    )
  }
}

async function applyCarrierMaterial(client, material, actor) {
  const { workspace, account, identity, secret, placeholder } = material
  const locked = await client.query(
    `SELECT account.status, account.external_account_id,
            account.credential_reference, account.configuration,
            fence.verification_state, placeholder.state,
            placeholder.target_account_number_fingerprint,
            placeholder.id::text, placeholder.global_id, placeholder.provider,
            placeholder.environment, placeholder.display_name, placeholder.sender_name,
            placeholder.source_carrier_account_id::text,
            placeholder.source_carrier_account_global_id,
            placeholder.source_account_number_last_four,
            placeholder.source_account_number_fingerprint,
            placeholder.source_registered_address_fingerprint,
            placeholder.rebind_mode,
            placeholder.required_source_authority_organization_id::text,
            placeholder.required_source_authority_integration_account_id::text,
            placeholder.required_source_authority_carrier_account_id::text,
            placeholder.required_source_organization_reference,
            placeholder.required_source_integration_global_id,
            placeholder.required_source_carrier_account_global_id
     FROM operations_integration_accounts account
     JOIN operations_commerce_migration_provider_identity_fences fence
       ON fence.organization_id = account.organization_id
      AND fence.integration_account_id = account.id
     JOIN operations_carrier_account_migration_placeholders placeholder
       ON placeholder.organization_id = account.organization_id
      AND placeholder.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid AND account.id = $2::uuid
     FOR UPDATE OF account, fence, placeholder`,
    [workspace.targetOrganizationId, identity.integrationId],
  )
  const state = locked.rows[0]
  if (
    locked.rowCount !== 1 || state.status !== 'disabled'
    || state.external_account_id !== null || state.credential_reference !== null
    || state.verification_state !== 'awaiting_provider_identity'
    || state.state !== 'awaiting_credential_rebind'
    || state.target_account_number_fingerprint !== null
    || canonicalJson(targetConfigurationEvidence(state.configuration, account))
      !== canonicalJson(placeholder.targetConfiguration)
    || canonicalJson(carrierPlaceholderStateEvidence(state))
      !== canonicalJson(placeholder.carrierPlaceholderState)
  ) fail(`${account.sourceGlobalId} carrier placeholder changed before commit`)
  await client.query(
    `INSERT INTO operations_carrier_credentials (
       organization_id, integration_account_id,
       credential_ciphertext, credential_iv, credential_tag,
       credential_version, client_id_last_four, account_number_last_four,
       verification_status, verified_at, last_error_code, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, 1, $6, $7,
       'verified', clock_timestamp(), NULL, $8, $8
     )`,
    [
      workspace.targetOrganizationId,
      identity.integrationId,
      secret.encryptedCredential.ciphertext,
      secret.encryptedCredential.iv,
      secret.encryptedCredential.tag,
      material.verification.clientIdLastFour,
      placeholder.carrierPlaceholder.source_account_number_last_four,
      actor,
    ],
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       id, global_id, organization_id, integration_account_id,
       display_name, sender_name,
       account_number_ciphertext, account_number_iv, account_number_tag,
       encryption_version, account_number_last_four,
       account_number_fingerprint, registered_address,
       registered_address_fingerprint, address_verification,
       allow_sender_billing, allow_recipient_billing, allow_third_party_billing,
       status, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9,
       1, $10, $11, $12::jsonb, $13, $14,
       $15, $16, $17, 'active', $18, $18
     )`,
    [
      identity.carrierAccountId,
      identity.carrierAccountGlobalId,
      workspace.targetOrganizationId,
      identity.integrationId,
      secret.displayName,
      secret.senderName,
      secret.encryptedAccountNumber.ciphertext.toString('base64'),
      secret.encryptedAccountNumber.iv.toString('base64'),
      secret.encryptedAccountNumber.tag.toString('base64'),
      placeholder.carrierPlaceholder.source_account_number_last_four,
      secret.targetAccountFingerprint,
      JSON.stringify(secret.registeredAddress),
      placeholder.carrierPlaceholder.source_registered_address_fingerprint,
      secret.addressVerification,
      secret.allowSenderBilling,
      secret.allowRecipientBilling,
      secret.allowThirdPartyBilling,
      actor,
    ],
  )
  const materialized = await client.query(
    `UPDATE operations_carrier_account_migration_placeholders
     SET state = 'materialized', target_account_number_fingerprint = $3,
         materialized_by = $4, materialized_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid
       AND id = $5::uuid AND global_id = $6
       AND state = 'awaiting_credential_rebind'
     RETURNING state`,
    [
      workspace.targetOrganizationId,
      identity.integrationId,
      secret.targetAccountFingerprint,
      actor,
      identity.carrierAccountId,
      identity.carrierAccountGlobalId,
    ],
  )
  if (materialized.rowCount !== 1) fail(`${account.sourceGlobalId} carrier account did not materialize`)
  const fence = await client.query(
    `UPDATE operations_commerce_migration_provider_identity_fences
     SET verification_state = 'verified',
         verified_carrier_account_id = $3::uuid,
         verified_carrier_account_identity_sha256 = $4,
         verified_by = $5, verified_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid
       AND integration_type = 'carrier'
       AND verification_state = 'awaiting_provider_identity'
     RETURNING verification_state`,
    [
      workspace.targetOrganizationId,
      identity.integrationId,
      identity.carrierAccountId,
      secret.targetAccountFingerprint,
      actor,
    ],
  )
  if (fence.rowCount !== 1) fail(`${account.sourceGlobalId} carrier identity fence did not verify`)
  const updated = await client.query(
    `UPDATE operations_integration_accounts
     SET status = 'active', configuration = $3::jsonb,
         credential_reference = $4, updated_by = $5,
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND id = $2::uuid
       AND status = 'disabled' AND external_account_id IS NULL
       AND credential_reference IS NULL
     RETURNING global_id`,
    [
      workspace.targetOrganizationId,
      identity.integrationId,
      JSON.stringify(secret.configuration),
      `carrier-credential:${identity.integrationId}:v1`,
      actor,
    ],
  )
  if (updated.rowCount !== 1 || updated.rows[0].global_id !== identity.integrationGlobalId) {
    fail(`${account.sourceGlobalId} carrier placeholder did not activate`)
  }
}

async function assertMaterializedTarget(client, material, targetKey, actor) {
  const { workspace, account, identity, secret } = material
  if (account.integrationType === 'commerce') {
    const result = await client.query(
      `SELECT account.status, account.external_account_id,
              account.commerce_credential_generation,
              account.receipt_intake_enabled, account.configuration,
              credential.auth_mode, credential.credential_ciphertext,
              credential.credential_iv, credential.credential_tag,
              credential.credential_version, credential.verification_status,
              credential.webhook_verification_status, fence.verification_state,
              control.desired_state, control.explicit_choice,
              history.provider AS history_provider, history.history_mode,
              history.ingestion_floor, history.frozen_at, history.configured_by
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_commerce_migration_provider_identity_fences fence
         ON fence.organization_id = account.organization_id
        AND fence.integration_account_id = account.id
       JOIN operations_commerce_store_sync_controls control
         ON control.organization_id = account.organization_id
        AND control.integration_account_id = account.id
       JOIN operations_commerce_order_history_policies history
         ON history.organization_id = account.organization_id
        AND history.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid AND account.id = $2::uuid`,
      [workspace.targetOrganizationId, identity.integrationId],
    )
    const row = result.rows[0]
    if (
      result.rowCount !== 1 || row.status !== 'active'
      || row.external_account_id !== secret.externalAccountId
      || Number(row.commerce_credential_generation) !== 1
      || Number(row.credential_version) !== 1
      || row.verification_status !== 'verified'
      || row.verification_state !== 'verified'
      || row.desired_state !== 'running' || row.explicit_choice !== true
      || row.receipt_intake_enabled !== (account.provider === 'shopify')
      || row.webhook_verification_status
        !== (account.provider === 'shopify' ? 'unverified' : 'not_applicable')
      || canonicalJson(historyPolicyEvidence(row, account, actor))
        !== canonicalJson(material.placeholder.historyPolicy)
    ) fail(`${account.sourceGlobalId} target commerce post-state is incomplete`)
    const plaintext = decryptAesGcm({
      ciphertext: bytea(row.credential_ciphertext, 'Target commerce ciphertext'),
      iv: bytea(row.credential_iv, 'Target commerce IV'),
      tag: bytea(row.credential_tag, 'Target commerce tag'),
    }, targetKey, commerceAad(
      workspace.targetOrganizationId,
      account.provider,
      account.environment,
      row.external_account_id,
    ), 'Target commerce credential')
    if (canonicalJson(parseCredentialJson(plaintext, 'Target commerce credential'))
      !== canonicalJson(secret.credential)) {
      plaintext.fill(0)
      fail(`${account.sourceGlobalId} target commerce credential round trip changed`)
    }
    plaintext.fill(0)
    return
  }
  const result = await client.query(
    `SELECT account.status, account.credential_reference, account.configuration,
            credential.credential_ciphertext, credential.credential_iv,
            credential.credential_tag, credential.verification_status,
            carrier.account_number_ciphertext, carrier.account_number_iv,
            carrier.account_number_tag, carrier.account_number_last_four,
            carrier.account_number_fingerprint,
            carrier.registered_address_fingerprint, carrier.status AS carrier_status,
            placeholder.state AS placeholder_state,
            fence.verification_state
     FROM operations_integration_accounts account
     JOIN operations_carrier_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_carrier_accounts carrier
       ON carrier.organization_id = account.organization_id
      AND carrier.integration_account_id = account.id
      AND carrier.id = $3::uuid
     JOIN operations_carrier_account_migration_placeholders placeholder
       ON placeholder.organization_id = account.organization_id
      AND placeholder.integration_account_id = account.id
     JOIN operations_commerce_migration_provider_identity_fences fence
       ON fence.organization_id = account.organization_id
      AND fence.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid AND account.id = $2::uuid`,
    [workspace.targetOrganizationId, identity.integrationId, identity.carrierAccountId],
  )
  const row = result.rows[0]
  if (
    result.rowCount !== 1 || row.status !== 'active'
    || row.verification_status !== 'verified' || row.carrier_status !== 'active'
    || row.placeholder_state !== 'materialized' || row.verification_state !== 'verified'
    || row.account_number_last_four
      !== material.placeholder.carrierPlaceholder.source_account_number_last_four
    || row.account_number_fingerprint !== secret.targetAccountFingerprint
    || row.registered_address_fingerprint
      !== material.placeholder.carrierPlaceholder.source_registered_address_fingerprint
  ) fail(`${account.sourceGlobalId} target carrier post-state is incomplete`)
  const credentialPlaintext = decryptAesGcm({
    ciphertext: bytea(row.credential_ciphertext, 'Target carrier credential ciphertext'),
    iv: bytea(row.credential_iv, 'Target carrier credential IV'),
    tag: bytea(row.credential_tag, 'Target carrier credential tag'),
  }, targetKey, carrierCredentialAad(
    workspace.targetOrganizationId,
    account.provider,
    account.environment,
  ), 'Target carrier credential')
  if (canonicalJson(parseCredentialJson(credentialPlaintext, 'Target carrier credential'))
    !== canonicalJson(secret.credential)) {
    credentialPlaintext.fill(0)
    fail(`${account.sourceGlobalId} target carrier credential round trip changed`)
  }
  credentialPlaintext.fill(0)
  const accountNumberPlaintext = decryptAesGcm({
    ciphertext: encodedCiphertext(row.account_number_ciphertext, 'Target carrier account ciphertext'),
    iv: encodedCiphertext(row.account_number_iv, 'Target carrier account IV'),
    tag: encodedCiphertext(row.account_number_tag, 'Target carrier account tag'),
  }, targetKey, carrierAccountAad(
    workspace.targetOrganizationId,
    account.provider,
    account.environment,
    identity.carrierAccountGlobalId,
  ), 'Target carrier account')
  if (accountNumberPlaintext.toString('utf8') !== secret.accountNumber) {
    accountNumberPlaintext.fill(0)
    fail(`${account.sourceGlobalId} target carrier round trip changed`)
  }
  accountNumberPlaintext.fill(0)
}

function reviewedReceiptProviders(plan) {
  return plan.providers.map((provider) => {
    const evidence = structuredClone(provider)
    if (provider.provider === 'shopify') {
      evidence.callback.actionsApplied = evidence.callback.actions.length
      evidence.callback.providerWritesDuringApply = evidence.callback.actions.length
      evidence.callback.verifiedAfterApply = true
    }
    return evidence
  })
}

function rebindReceiptPayload(input, workspace, materials, plan, providerWrites) {
  const selected = materials.filter((material) => material.workspace.key === workspace.key)
  const selectedSourceIds = new Set(selected.map((material) => material.account.sourceGlobalId))
  const providers = reviewedReceiptProviders(plan).filter((provider) => (
    selectedSourceIds.has(provider.sourceAccountGlobalId)
  ))
  const payload = {
    format: RECEIPT_FORMAT,
    scriptVersion: SCRIPT_VERSION,
    planDigest: plan.planDigest,
    migrationManifestDigest: input.manifest.manifestDigest,
    migrationMappingDigest: digest(input.mapping),
    migrationReceiptIdentityDigest: mappingWorkspace(
      input.mapping,
      workspace,
    ).receiptIdentityDigest,
    source: {
      databaseIdentity: SOURCE_DATABASE_IDENTITY,
      endpointSha256: input.bindings.source,
      organizationId: workspace.sourceOrganizationId,
      organizationReference: workspace.sourceOrganizationReference,
    },
    target: {
      databaseIdentity: TARGET_DATABASE_IDENTITY,
      endpointSha256: input.bindings.target,
      organizationId: workspace.targetOrganizationId,
      organizationReference: workspace.targetOrganizationReference,
    },
    providers,
    accountsMaterialized: selected.length,
    providerWrites,
    sourceRowsCopied: { ...ZERO_SOURCE_ROWS_COPIED },
    targetTransaction: 'committed_atomically',
  }
  assertNoSecrets(payload, 'Rebind receipt')
  payload.receiptDigest = digest(payload)
  return payload
}

async function insertRebindReceipt(client, input, workspace, materials, plan, providerWrites) {
  const payload = rebindReceiptPayload(input, workspace, materials, plan, providerWrites)
  const eventKey = `migrated-provider-rebind:${SCRIPT_VERSION}:${workspace.targetOrganizationId}:${plan.planDigest}`
  const result = await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload, event_key,
       subject, organization_id, is_system
     ) VALUES (
       $1, 'operations.migrated_provider_rebind.completed',
       'workspace_organization', $2::text, $3::jsonb, $4,
       $1, $2::uuid, false
     ) ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING
     RETURNING event_key, created_at`,
    [input.actor, workspace.targetOrganizationId, JSON.stringify(payload), eventKey],
  )
  if (result.rowCount !== 1) fail(`${workspace.key} rebind receipt already exists or was not inserted`)
  return { eventKey, payload, createdAt: result.rows[0].created_at }
}

async function reconcileReviewedCallbacks(materials, verifier) {
  let writes = 0
  for (const material of materials) {
    if (material.account.provider !== 'shopify') continue
    const expected = material.redacted.callback.actions
    const after = await verifier.reconcileShopify(material.verification, expected)
    if (!after.ready) fail(`${material.account.sourceGlobalId} callback did not become ready`)
    material.verification.webhooks = after
    writes += expected.length
  }
  return writes
}

async function lockReviewedTargetAccount(client, material, actor) {
  const { workspace, account, identity } = material
  if (account.integrationType === 'commerce') {
    const locked = await client.query(
      `SELECT account.status, account.external_account_id,
              account.credential_reference, account.commerce_credential_generation,
              account.receipt_intake_enabled, account.configuration,
              fence.verification_state,
              control.desired_state AS sync_desired_state,
              control.explicit_choice AS sync_explicit_choice,
              control.revision AS sync_revision,
              control.reason AS sync_reason,
              control.created_by AS sync_created_by,
              control.updated_by AS sync_updated_by,
              control.created_at::text AS sync_created_at,
              control.updated_at::text AS sync_updated_at
       FROM operations_integration_accounts account
       JOIN operations_commerce_migration_provider_identity_fences fence
         ON fence.organization_id = account.organization_id
        AND fence.integration_account_id = account.id
       JOIN operations_commerce_store_sync_controls control
         ON control.organization_id = account.organization_id
        AND control.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid AND account.id = $2::uuid
       FOR UPDATE OF account, fence, control`,
      [workspace.targetOrganizationId, identity.integrationId],
    )
    const state = locked.rows[0]
    if (
      locked.rowCount !== 1 || state.status !== 'disabled'
      || state.external_account_id !== null || state.credential_reference !== null
      || Number(state.commerce_credential_generation) !== 0
      || state.receipt_intake_enabled !== false
      || state.verification_state !== 'awaiting_provider_identity'
      || canonicalJson(targetConfigurationEvidence(state.configuration, account))
        !== canonicalJson(material.placeholder.targetConfiguration)
      || canonicalJson(storeSyncControlEvidence(state, account))
        !== canonicalJson(material.placeholder.storeSyncControl)
    ) fail(`${account.sourceGlobalId} commerce placeholder changed before provider reconciliation`)
    const policy = await client.query(
      `SELECT 1
       FROM operations_commerce_order_history_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [workspace.targetOrganizationId, identity.integrationId],
    )
    if (policy.rowCount !== 0) {
      fail(`${account.sourceGlobalId} commerce placeholder changed before provider reconciliation`)
    }
    return
  }
  const locked = await client.query(
    `SELECT account.status, account.external_account_id,
            account.credential_reference, account.configuration,
            fence.verification_state, placeholder.state,
            placeholder.target_account_number_fingerprint,
            placeholder.id::text, placeholder.global_id, placeholder.provider,
            placeholder.environment, placeholder.display_name, placeholder.sender_name,
            placeholder.source_carrier_account_id::text,
            placeholder.source_carrier_account_global_id,
            placeholder.source_account_number_last_four,
            placeholder.source_account_number_fingerprint,
            placeholder.source_registered_address_fingerprint,
            placeholder.rebind_mode,
            placeholder.required_source_authority_organization_id::text,
            placeholder.required_source_authority_integration_account_id::text,
            placeholder.required_source_authority_carrier_account_id::text,
            placeholder.required_source_organization_reference,
            placeholder.required_source_integration_global_id,
            placeholder.required_source_carrier_account_global_id
     FROM operations_integration_accounts account
     JOIN operations_commerce_migration_provider_identity_fences fence
       ON fence.organization_id = account.organization_id
      AND fence.integration_account_id = account.id
     JOIN operations_carrier_account_migration_placeholders placeholder
       ON placeholder.organization_id = account.organization_id
      AND placeholder.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid AND account.id = $2::uuid
     FOR UPDATE OF account, fence, placeholder`,
    [workspace.targetOrganizationId, identity.integrationId],
  )
  const state = locked.rows[0]
  if (
    locked.rowCount !== 1 || state.status !== 'disabled'
    || state.external_account_id !== null || state.credential_reference !== null
    || state.verification_state !== 'awaiting_provider_identity'
    || state.state !== 'awaiting_credential_rebind'
    || state.target_account_number_fingerprint !== null
    || canonicalJson(targetConfigurationEvidence(state.configuration, account))
      !== canonicalJson(material.placeholder.targetConfiguration)
    || canonicalJson(carrierPlaceholderStateEvidence(state))
      !== canonicalJson(material.placeholder.carrierPlaceholderState)
  ) fail(`${account.sourceGlobalId} carrier placeholder changed before provider reconciliation`)
}

async function insertReviewedHistoryPolicy(client, material, actor) {
  if (material.account.integrationType !== 'commerce') return
  const { workspace, account, identity, placeholder } = material
  const policy = placeholder.historyPolicy
  const inserted = await client.query(
    `INSERT INTO operations_commerce_order_history_policies (
       organization_id, integration_account_id, provider, history_mode,
       ingestion_floor, frozen_at, configured_by
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $7)
     RETURNING provider AS history_provider, history_mode, ingestion_floor,
               frozen_at, configured_by`,
    [
      workspace.targetOrganizationId,
      identity.integrationId,
      policy.provider,
      policy.historyMode,
      policy.ingestionFloor,
      policy.frozenAt,
      actor,
    ],
  )
  if (
    inserted.rowCount !== 1
    || canonicalJson(historyPolicyEvidence(inserted.rows[0], account, actor))
      !== canonicalJson(policy)
  ) fail(`${account.sourceGlobalId} reviewed order-history policy was not inserted atomically`)
}

export async function applyValidatedMaterials(input, materials, plan) {
  if (
    !Array.isArray(materials)
    || materials.length !== 1
    || materials[0]?.account?.sourceGlobalId !== plan?.selectedSourceAccountGlobalId
    || plan?.transaction?.providerCount !== 1
  ) fail('Exactly one reviewed provider material may be applied per rebind transaction')
  if (typeof input.target?.release !== 'function') {
    fail('A dedicated target database client is required for the rebind transaction')
  }
  await input.target.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await lockReviewedTargetAccount(input.target, materials[0], input.actor)
    await assertDatabaseBoundary(input.source, input.target)
    await assertCommittedMigrationReceipts(
      input.target,
      input.manifest,
      input.mapping,
      input.workspaces || WORKSPACES,
    )
    assertReviewedPlan(plan, input, materials)
    await insertReviewedHistoryPolicy(input.target, materials[0], input.actor)
    const providerWrites = await reconcileReviewedCallbacks(materials, input.verifier)
    for (const material of materials) {
      if (material.account.integrationType === 'commerce') {
        await applyCommerceMaterial(input.target, material, input.actor)
      } else {
        await applyCarrierMaterial(input.target, material, input.actor)
      }
      await assertMaterializedTarget(input.target, material, input.targetKey, input.actor)
    }
    const receipts = []
    const selectedWorkspaces = [...new Map(
      materials.map((material) => [material.workspace.key, material.workspace]),
    ).values()]
    for (const workspace of selectedWorkspaces) {
      const workspaceMaterials = materials.filter((material) => material.workspace.key === workspace.key)
      const workspaceWrites = workspaceMaterials.reduce((sum, material) => (
        sum + (material.account.provider === 'shopify'
          ? material.redacted.callback.actions.length
          : 0)
      ), 0)
      receipts.push(await insertRebindReceipt(
        input.target,
        input,
        workspace,
        materials,
        plan,
        workspaceWrites,
      ))
    }
    await input.target.query('COMMIT')
    return { receipts, providerWrites }
  } catch (error) {
    await input.target.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

export async function planRebind(input) {
  const workspaces = input.workspaces || WORKSPACES
  const selected = selectedProviderScope({ ...input, workspaces })
  const historyMode = text(input.historyMode)
  if (selected.account.integrationType === 'commerce' && !historyMode) {
    fail('--history-mode is required when planning a commerce provider rebind')
  }
  if (selected.account.integrationType !== 'commerce' && historyMode) {
    fail('--history-mode is accepted only for a commerce provider rebind plan')
  }
  const createdAt = new Date().toISOString()
  const plannedHistoryPolicy = selected.account.integrationType === 'commerce'
    ? plannedHistoryPolicyEvidence({
      account: selected.account,
      actor: input.actor,
      historyMode,
      frozenAt: createdAt,
    })
    : null
  await assertDatabaseBoundary(input.source, input.target)
  await assertTargetSchema(input.target)
  assertMigrationArtifacts(
    input.manifest,
    input.mapping,
    input.bindings,
    input.actor,
    workspaces,
  )
  await assertCommittedMigrationReceipts(
    input.target,
    input.manifest,
    input.mapping,
    workspaces,
  )
  const materials = await collectValidatedMaterials({
    ...input,
    workspaces,
    plannedHistoryPolicy,
  })
  return {
    plan: buildPlanArtifact({ ...input, workspaces }, materials, createdAt),
    materials,
  }
}

export async function applyRebind(input) {
  const workspaces = input.workspaces || WORKSPACES
  if (text(input.historyMode)) {
    fail('--history-mode is not accepted during apply; use the reviewed plan choice')
  }
  assertPlanEnvelope(input.plan, { ...input, workspaces })
  const selected = selectedProviderScope({ ...input, workspaces })
  assertReviewedManagedMaterialCommitment(input, selected.account)
  let plannedHistoryPolicy = null
  if (selected.account.integrationType === 'commerce') {
    const reviewedPolicy = input.plan.providers?.[0]?.orderHistoryPolicy
    const recomputedPolicy = plannedHistoryPolicyEvidence({
      account: selected.account,
      actor: input.actor,
      historyMode: reviewedPolicy?.historyMode,
      frozenAt: input.plan.createdAt,
    })
    if (canonicalJson(reviewedPolicy) !== canonicalJson(recomputedPolicy)) {
      fail('The reviewed order-history policy is not derived from the confirmed rebind plan')
    }
    plannedHistoryPolicy = recomputedPolicy
  }
  await assertDatabaseBoundary(input.source, input.target)
  await assertTargetSchema(input.target)
  assertMigrationArtifacts(
    input.manifest,
    input.mapping,
    input.bindings,
    input.actor,
    workspaces,
  )
  await assertCommittedMigrationReceipts(
    input.target,
    input.manifest,
    input.mapping,
    workspaces,
  )
  const materials = await collectValidatedMaterials({
    ...input,
    workspaces,
    plannedHistoryPolicy,
  })
  assertReviewedPlan(input.plan, { ...input, workspaces }, materials)
  const result = await applyValidatedMaterials({ ...input, workspaces }, materials, input.plan)
  return buildReceiptArtifact(input, input.plan, result.receipts)
}

function rebindPayloadDigest(payload) {
  const copy = structuredClone(payload)
  delete copy.receiptDigest
  return digest(copy)
}

function buildReceiptArtifact(input, plan, receipts) {
  const ordered = [...receipts].sort((left, right) => (
    left.payload.target.organizationId.localeCompare(right.payload.target.organizationId)
  ))
  const completedAt = ordered.reduce((latest, entry) => {
    const candidate = new Date(entry.createdAt).toISOString()
    return !latest || candidate > latest ? candidate : latest
  }, '')
  const receipt = {
    format: RECEIPT_FORMAT,
    scriptVersion: SCRIPT_VERSION,
    completedAt,
    actor: input.actor,
    planDigest: plan.planDigest,
    migrationManifestDigest: input.manifest.manifestDigest,
    sourceDatabaseIdentity: SOURCE_DATABASE_IDENTITY,
    targetDatabaseIdentity: TARGET_DATABASE_IDENTITY,
    providerWrites: ordered.reduce((sum, entry) => sum + Number(entry.payload.providerWrites), 0),
    receipts: ordered.map((entry) => ({
      eventKey: entry.eventKey,
      receiptDigest: entry.payload.receiptDigest,
      targetOrganizationId: entry.payload.target.organizationId,
    })),
    status: 'committed',
  }
  assertNoSecrets(receipt, 'Rebind receipt artifact')
  receipt.receiptArtifactDigest = digest(receipt)
  return receipt
}

async function assertReceiptPostState(
  target,
  workspace,
  account,
  identity,
  providerEvidence,
  actor,
) {
  const result = await target.query(
    `SELECT account.status, fence.verification_state,
            credential.verification_status AS commerce_credential_status,
            carrier_credential.verification_status AS carrier_credential_status,
            placeholder.state AS carrier_placeholder_state,
            fence.verified_carrier_account_id::text AS verified_carrier_account_id,
            history.provider AS history_provider, history.history_mode,
            history.ingestion_floor, history.frozen_at, history.configured_by
     FROM operations_integration_accounts account
     JOIN operations_commerce_migration_provider_identity_fences fence
       ON fence.organization_id = account.organization_id
      AND fence.integration_account_id = account.id
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     LEFT JOIN operations_carrier_credentials carrier_credential
       ON carrier_credential.organization_id = account.organization_id
      AND carrier_credential.integration_account_id = account.id
     LEFT JOIN operations_carrier_account_migration_placeholders placeholder
       ON placeholder.organization_id = account.organization_id
      AND placeholder.integration_account_id = account.id
     LEFT JOIN operations_commerce_order_history_policies history
       ON history.organization_id = account.organization_id
      AND history.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid AND account.id = $2::uuid`,
    [workspace.targetOrganizationId, identity.integrationId],
  )
  const row = result.rows[0]
  if (
    result.rowCount !== 1 || row.status !== 'active' || row.verification_state !== 'verified'
    || (account.integrationType === 'commerce'
      && (
        row.commerce_credential_status !== 'verified'
        || canonicalJson(historyPolicyEvidence(row, account, actor))
          !== canonicalJson(providerEvidence?.orderHistoryPolicy)
      ))
    || (account.integrationType === 'carrier'
      && (
        row.carrier_credential_status !== 'verified'
        || row.carrier_placeholder_state !== 'materialized'
        || row.verified_carrier_account_id !== identity.carrierAccountId
      ))
  ) fail(`${account.sourceGlobalId} committed rebind post-state is incomplete`)
}

export async function exportCommittedReceipt(input) {
  const workspaces = input.workspaces || WORKSPACES
  const selected = selectedProviderScope({ ...input, workspaces })
  await assertTargetDatabaseBoundary(input.target)
  await assertTargetSchema(input.target)
  assertMigrationArtifacts(
    input.manifest,
    input.mapping,
    input.bindings,
    input.actor,
    workspaces,
  )
  await assertCommittedMigrationReceipts(input.target, input.manifest, input.mapping, workspaces)
  assertPlanEnvelope(input.plan, { ...input, workspaces })
  const { workspace, account } = selected
  const eventKey = `migrated-provider-rebind:${SCRIPT_VERSION}:${workspace.targetOrganizationId}:${input.plan.planDigest}`
  const result = await input.target.query(
    `SELECT actor, event_type, aggregate_type, aggregate_id,
            event_key, payload, subject, organization_id::text, is_system, created_at
     FROM audit_events
     WHERE organization_id = $1::uuid
       AND event_type = 'operations.migrated_provider_rebind.completed'
       AND event_key = $2`,
    [workspace.targetOrganizationId, eventKey],
  )
  const payload = result.rows[0]?.payload
  const expectedProviders = reviewedReceiptProviders(input.plan)
  const expectedProviderWrites = expectedProviders.reduce((sum, provider) => (
    sum + (provider.provider === 'shopify' ? provider.callback.actions.length : 0)
  ), 0)
  const observedProviders = Array.isArray(payload?.providers)
    ? payload.providers.map((provider) => provider?.sourceAccountGlobalId)
    : []
  if (
    result.rowCount !== 1
    || result.rows[0].actor !== input.actor
    || result.rows[0].event_type !== 'operations.migrated_provider_rebind.completed'
    || result.rows[0].aggregate_type !== 'workspace_organization'
    || result.rows[0].aggregate_id !== workspace.targetOrganizationId
    || result.rows[0].subject !== input.actor
    || result.rows[0].organization_id !== workspace.targetOrganizationId
    || result.rows[0].is_system !== false
    || payload?.format !== RECEIPT_FORMAT
    || payload.scriptVersion !== SCRIPT_VERSION
    || payload.planDigest !== input.plan.planDigest
    || payload.migrationManifestDigest !== input.manifest.manifestDigest
    || payload.migrationMappingDigest !== digest(input.mapping)
    || payload.migrationReceiptIdentityDigest
      !== mappingWorkspace(input.mapping, workspace).receiptIdentityDigest
    || payload.source?.databaseIdentity !== SOURCE_DATABASE_IDENTITY
    || payload.source?.endpointSha256 !== input.bindings.source
    || payload.source?.organizationId !== workspace.sourceOrganizationId
    || payload.source?.organizationReference !== workspace.sourceOrganizationReference
    || payload.target?.databaseIdentity !== TARGET_DATABASE_IDENTITY
    || payload.target?.endpointSha256 !== input.bindings.target
    || payload.target?.organizationId !== workspace.targetOrganizationId
    || payload.target?.organizationReference !== workspace.targetOrganizationReference
    || payload.accountsMaterialized !== 1
    || payload.providerWrites !== expectedProviderWrites
    || canonicalJson(payload.providers) !== canonicalJson(expectedProviders)
    || canonicalJson(observedProviders) !== canonicalJson([account.sourceGlobalId])
    || payload.targetTransaction !== 'committed_atomically'
    || payload.receiptDigest !== rebindPayloadDigest(payload)
    || canonicalJson(payload.sourceRowsCopied) !== canonicalJson(ZERO_SOURCE_ROWS_COPIED)
  ) fail(`${workspace.key} committed rebind receipt is missing or invalid`)
  assertNoSecrets(payload, 'Committed rebind receipt')
  await assertReceiptPostState(
    input.target,
    workspace,
    account,
    targetIdentity(input.mapping, workspace, account),
    payload.providers[0],
    input.actor,
  )
  const receipts = [{
    eventKey: result.rows[0].event_key,
    payload,
    createdAt: result.rows[0].created_at,
  }]
  return buildReceiptArtifact(input, input.plan, receipts)
}

function safeFailureMessage(error) {
  const raw = error instanceof Error ? error.message : 'unknown failure'
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[database-url-redacted]')
    .replace(/[A-Za-z0-9+/_=-]{64,}/gu, '[opaque-value-redacted]')
    .slice(0, 500)
}

export async function main(runtime = {}) {
  const environment = runtime.environment || process.env
  const args = runtime.args || parseArguments(process.argv.slice(2))
  if (runtime.workspaces && runtime.allowTestBoundary !== true) {
    fail('Workspace allowlist overrides are test-only')
  }
  if (runtime.managedRebindMaterial !== undefined && runtime.allowTestBoundary !== true) {
    fail('Managed carrier runtime material overrides are test-only')
  }
  const manifest = runtime.manifest || parsePrivateJson(args.manifest, 'Migration manifest')
  const mapping = runtime.mapping || parsePrivateJson(args.mapping, 'Migration mapping receipt')
  const workspaces = runtime.workspaces || WORKSPACES
  const selected = selectedProviderScope({
    selectedAccountGlobalId: args.selectedAccountGlobalId,
    workspaces,
  })
  if (
    args.command === 'plan'
    && selected.account.integrationType === 'commerce'
    && !args.historyMode
  ) fail('--history-mode is required when planning a commerce provider rebind')
  if (
    args.command === 'plan'
    && selected.account.integrationType !== 'commerce'
    && args.historyMode
  ) fail('--history-mode is accepted only for a commerce provider rebind plan')
  const plan = args.command !== 'plan'
    ? (runtime.plan || parsePrivateJson(args.plan, 'Reviewed rebind plan'))
    : null

  if (args.command === 'export-receipt') {
    if (runtime.managedRebindMaterial !== undefined) {
      fail('Committed receipt export never accepts carrier reauthentication material')
    }
    assertTargetRailwayBoundary(environment)
    const targetUrl = validatedDatabaseUrl(environment.TARGET_DATABASE_URL, 'TARGET_DATABASE_URL')
    const sourceEndpoint = text(manifest.sourceDatabase?.endpoint_sha256).toLowerCase()
    if (!SHA256.test(sourceEndpoint)) fail('Approved manifest source endpoint binding is invalid')
    const bindings = {
      source: sourceEndpoint,
      target: targetEndpointBinding(environment, targetUrl),
    }
    const targetPool = poolFor(targetUrl, runtime)
    const target = await targetPool.connect()
    let targetReadTransaction = false
    try {
      await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      targetReadTransaction = true
      const receipt = await exportCommittedReceipt({
        actor: args.actor,
        target,
        manifest,
        mapping,
        bindings,
        workspaces,
        selectedAccountGlobalId: args.selectedAccountGlobalId,
        plan,
        confirmDigest: args.confirmDigest,
      })
      await target.query('COMMIT')
      targetReadTransaction = false
      writePrivateJson(args.receiptOutput, receipt)
      return {
        command: 'export-receipt',
        planDigest: receipt.planDigest,
        receiptArtifactDigest: receipt.receiptArtifactDigest,
        receiptCount: receipt.receipts.length,
      }
    } catch (error) {
      if (targetReadTransaction) await target.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      target.release()
      await targetPool.end().catch(() => undefined)
    }
  }

  assertRailwayBoundary(environment)
  const sourceUrl = validatedDatabaseUrl(environment.SOURCE_DATABASE_URL, 'SOURCE_DATABASE_URL')
  const targetUrl = validatedDatabaseUrl(environment.TARGET_DATABASE_URL, 'TARGET_DATABASE_URL')
  const sourceKey = requiredSecret(environment, 'SOURCE_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY')
  const targetKey = requiredSecret(environment, 'TARGET_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY')
  if (sourceKey === targetKey) fail('Source and target encryption keys must be independently supplied')
  const bindings = endpointBindings(environment, sourceUrl, targetUrl)
  assertMigrationArtifacts(manifest, mapping, bindings, args.actor, workspaces)
  let suppliedManagedMaterial = runtime.managedRebindMaterial
  const managedFdSupplied = args.managedRebindSecretsFd !== undefined
  const approvalSupplied = Boolean(args.confirmManagedSourceAuthority)
  if (selected.account.rebindMode === 'source_authority') {
    if (suppliedManagedMaterial !== undefined) {
      if (managedFdSupplied || approvalSupplied) {
        fail('Test carrier material cannot be combined with operator secret input')
      }
    } else {
      if (!managedFdSupplied) {
        fail('--managed-rebind-secrets-fd is required for a source-authority carrier rebind')
      }
      if (args.command === 'plan' && !approvalSupplied) {
        fail('--confirm-managed-source-authority is required during source-authority plan review')
      }
    }
  } else if (suppliedManagedMaterial !== undefined || managedFdSupplied || approvalSupplied) {
    fail('Managed carrier secret input is accepted only for a source-authority rebind')
  }
  const verifier = runtime.verifier || createProviderVerifier(runtime)
  const sourcePool = poolFor(sourceUrl, runtime)
  const targetPool = poolFor(targetUrl, runtime)
  const source = await sourcePool.connect()
  const target = await targetPool.connect()
  let sourceTransaction = false
  let targetReadTransaction = false
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    sourceTransaction = true
    await assertDatabaseBoundary(source, target)
    await assertTargetSchema(target)
    await assertCommittedMigrationReceipts(target, manifest, mapping, workspaces)
    if (args.command === 'apply') {
      assertPlanEnvelope(plan, {
        actor: args.actor,
        manifest,
        mapping,
        bindings,
        workspaces,
        selectedAccountGlobalId: args.selectedAccountGlobalId,
        confirmDigest: args.confirmDigest,
      })
    }
    if (selected.account.rebindMode === 'source_authority' && suppliedManagedMaterial === undefined) {
      const secretInput = readBoundedSecretJsonFd(
        args.managedRebindSecretsFd,
        'Managed carrier secret input',
      )
      suppliedManagedMaterial = buildManagedRebindMaterial({
        actor: args.actor,
        manifest,
        mapping,
        bindings,
        workspace: selected.workspace,
        account: selected.account,
        secretInput,
        approvalToken: args.command === 'plan'
          ? args.confirmManagedSourceAuthority
          : managedSourceAuthorityApprovalToken(selected.account),
      })
    }
    if (args.command === 'plan') {
      await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      targetReadTransaction = true
      const result = await planRebind({
        actor: args.actor,
        source,
        target,
        sourceKey,
        targetKey,
        manifest,
        mapping,
        bindings,
        verifier,
        workspaces,
        selectedAccountGlobalId: args.selectedAccountGlobalId,
        historyMode: args.historyMode,
        managedRebindMaterial: suppliedManagedMaterial,
      })
      await target.query('COMMIT')
      targetReadTransaction = false
      await source.query('COMMIT')
      sourceTransaction = false
      writePrivateJson(args.output, result.plan)
      return {
        command: 'plan',
        planDigest: result.plan.planDigest,
        providerCount: result.plan.providers.length,
      }
    }
    const receipt = await applyRebind({
      actor: args.actor,
      source,
      target,
      sourceKey,
      targetKey,
      manifest,
      mapping,
      bindings,
      verifier,
      workspaces,
      selectedAccountGlobalId: args.selectedAccountGlobalId,
      managedRebindMaterial: suppliedManagedMaterial,
      plan,
      confirmDigest: args.confirmDigest,
    })
    await source.query('COMMIT')
    sourceTransaction = false
    writePrivateJson(args.receiptOutput, receipt)
    return {
      command: 'apply',
      planDigest: receipt.planDigest,
      receiptArtifactDigest: receipt.receiptArtifactDigest,
      receiptCount: receipt.receipts.length,
    }
  } catch (error) {
    if (targetReadTransaction) await target.query('ROLLBACK').catch(() => undefined)
    if (sourceTransaction) await source.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    source.release()
    target.release()
    await Promise.all([
      sourcePool.end().catch(() => undefined),
      targetPool.end().catch(() => undefined),
    ])
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => {
    if (result.command === 'plan') {
      console.log(`Rebind plan ready: ${result.planDigest} (${result.providerCount} providers)`)
    } else if (result.command === 'apply') {
      console.log(
        `Rebind committed: ${result.receiptArtifactDigest} (${result.receiptCount} receipts)`,
      )
    } else {
      console.log(
        `Rebind receipt recovered: ${result.receiptArtifactDigest} (${result.receiptCount} receipts)`,
      )
    }
  }).catch((error) => {
    console.error(`Rebind failed closed: ${safeFailureMessage(error)}`)
    process.exitCode = 1
  })
}
