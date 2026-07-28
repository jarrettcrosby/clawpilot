#!/usr/bin/env node
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

export const SCRIPT_VERSION = 'ag-alchemy-carrier-sandbox-v1'
export const MANAGED_BY = 'ag-alchemy-episcs-sandbox-rating-delegation'
export const EXECUTION_CONFIRMATION = 'establish-ag-alchemy-carrier-sandbox-v1'
export const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
export const TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
export const SOURCE_ORGANIZATION_NAME =
  'Express Parcel International DBA EPISCS'
export const TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'
export const TARGET_WAREHOUSE_CODE = 'AG-ALCHEMY-01'
export const TARGET_WAREHOUSE_GLOBAL_ID = 'gwh5366613'
export const EXPECTED_PROVIDERS = Object.freeze(['fedex_rest', 'ups_rest'])

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PROVIDER_LABELS = Object.freeze({
  fedex_rest: 'FedEx',
  ups_rest: 'UPS',
})

function fail(message) {
  throw new Error(message)
}

function environmentValue(name) {
  return String(process.env[name] || '').trim()
}

function requiredText(value, label, maximum = 255) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > maximum) {
    fail(`${label} is missing or invalid`)
  }
  return normalized
}

function requireTrustedDevelopmentEnvironment() {
  if (
    environmentValue('RAILWAY_PROJECT_ID') !== TRUSTED_RAILWAY_PROJECT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_ID')
      !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_NAME') !== 'development'
  ) {
    fail('This command is restricted to the trusted ClawPilot development environment')
  }
}

function encryptionKey() {
  const secret = environmentValue('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY')
    || environmentValue('AGENT_CREDENTIAL_ENCRYPTION_KEY')
  if (secret.length < 32) {
    fail('Carrier credential encryption is not configured')
  }
  return crypto.createHash('sha256').update(secret).digest()
}

function credentialAad(organizationId, provider) {
  return Buffer.from(
    `clawpilot:carrier:${organizationId}:${provider}:sandbox:credential:v1`,
    'utf8',
  )
}

function carrierAccountAad(organizationId, provider, globalId) {
  return Buffer.from(
    `clawpilot:carrier:${organizationId}:${provider}:sandbox:account:${globalId}:v1`,
    'utf8',
  )
}

function decryptJson(fields, aad, label) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      fields.iv,
    )
    decipher.setAAD(aad)
    decipher.setAuthTag(fields.tag)
    return JSON.parse(Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ]).toString('utf8'))
  } catch {
    fail(`${label} could not be decrypted`)
  }
}

function decryptText(fields, aad, label) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      fields.iv,
    )
    decipher.setAAD(aad)
    decipher.setAuthTag(fields.tag)
    return Buffer.concat([
      decipher.update(fields.ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    fail(`${label} could not be decrypted`)
  }
}

function encryptJson(value, aad) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

function encryptText(value, aad) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

function accountNumberFingerprint(organizationId, provider, accountNumber) {
  const fingerprintKey = crypto
    .createHmac('sha256', encryptionKey())
    .update('clawpilot:carrier:fingerprint:v1', 'utf8')
    .digest()
  return crypto
    .createHmac('sha256', fingerprintKey)
    .update(`${organizationId}:${provider}:sandbox:${accountNumber}`, 'utf8')
    .digest('hex')
}

function normalizeCarrierAddress(value) {
  const address = value && typeof value === 'object' ? value : {}
  const line2 = String(address.line2 || '').trim()
  const normalized = {
    line1: requiredText(address.line1, 'Carrier origin address line 1', 160),
    line2: line2 || null,
    city: requiredText(address.city, 'Carrier origin city', 100),
    region: requiredText(address.region, 'Carrier origin region', 100),
    postalCode: requiredText(
      address.postalCode,
      'Carrier origin postal code',
      32,
    ),
    countryCode: requiredText(
      address.countryCode || address.country,
      'Carrier origin country',
      2,
    ).toUpperCase(),
  }
  if (!/^[A-Z]{2}$/.test(normalized.countryCode)) {
    fail('Carrier origin country must use a two-letter code')
  }
  return normalized
}

function addressFingerprint(value) {
  const address = normalizeCarrierAddress(value)
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      line1: address.line1.toLowerCase(),
      line2: address.line2?.toLowerCase() || null,
      city: address.city.toLowerCase(),
      region: address.region.toLowerCase(),
      postalCode: address.postalCode.toLowerCase().replace(/[\s-]/g, ''),
      countryCode: address.countryCode,
    }))
    .digest('hex')
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    )
  }
  return value
}

function stableDigest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)), 'utf8')
    .digest('hex')
}

function decryptSourceCredential(row) {
  const value = decryptJson({
    ciphertext: row.credential_ciphertext,
    iv: row.credential_iv,
    tag: row.credential_tag,
  }, credentialAad(row.organization_id, row.provider), 'Source carrier credential')
  return {
    clientId: requiredText(value?.clientId, 'Carrier client ID', 512),
    clientSecret: requiredText(
      value?.clientSecret,
      'Carrier client secret',
      4096,
    ),
    accountNumber: null,
  }
}

function decryptSourceAccountNumber(row) {
  return requiredText(decryptText({
    ciphertext: Buffer.from(row.account_number_ciphertext, 'base64'),
    iv: Buffer.from(row.account_number_iv, 'base64'),
    tag: Buffer.from(row.account_number_tag, 'base64'),
  }, carrierAccountAad(
    row.organization_id,
    row.provider,
    row.carrier_account_global_id,
  ), 'Source carrier account number'), 'Carrier account number', 128)
}

function decryptTargetCredential(row) {
  return decryptJson({
    ciphertext: row.credential_ciphertext,
    iv: row.credential_iv,
    tag: row.credential_tag,
  }, credentialAad(row.organization_id, row.provider), 'Target carrier credential')
}

function decryptTargetAccountNumber(row) {
  return decryptText({
    ciphertext: Buffer.from(row.account_number_ciphertext, 'base64'),
    iv: Buffer.from(row.account_number_iv, 'base64'),
    tag: Buffer.from(row.account_number_tag, 'base64'),
  }, carrierAccountAad(
    row.organization_id,
    row.provider,
    row.carrier_account_global_id,
  ), 'Target carrier account number')
}

function sameAddress(left, right) {
  return addressFingerprint(left) === addressFingerprint(right)
}

function expectedConfiguration(source, target) {
  return {
    authMode: 'oauth_client_credentials',
    accountOwnerType: 'operator_owned',
    authorizationScope: 'sandbox_rating_only',
    allowedCapabilities: ['sandbox_rate'],
    credentialRevealAllowed: false,
    managedBy: MANAGED_BY,
    delegatedFromOrganizationReferenceCode:
      source.organization.reference_code,
    sourceIntegrationGlobalId: source.integration_global_id,
    sourceCarrierAccountGlobalId: source.carrier_account_global_id,
    senderOriginWarehouseGlobalId: target.warehouse.global_id,
  }
}

function sameConfiguration(actual, expected) {
  return stableDigest(actual) === stableDigest(expected)
}

function tokenRequest(provider, credential) {
  if (provider === 'ups_rest') {
    return {
      url: 'https://wwwcie.ups.com/security/v1/oauth/token',
      init: {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(
            `${credential.clientId}:${credential.clientSecret}`,
            'utf8',
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
        }).toString(),
      },
    }
  }
  return {
    url: 'https://apis-sandbox.fedex.com/oauth/token',
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
      }).toString(),
    },
  }
}

async function verifySandboxCredential(provider, credential) {
  const request = tokenRequest(provider, credential)
  const response = await fetch(request.url, {
    ...request.init,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (
    !response.ok
    || (Number.isFinite(contentLength) && contentLength > 64 * 1024)
  ) {
    fail(`${PROVIDER_LABELS[provider]} rejected the sandbox credential`)
  }
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
    fail(`${PROVIDER_LABELS[provider]} returned an invalid verification response`)
  }
  let payload = null
  try {
    payload = JSON.parse(raw)
  } catch {
    fail(`${PROVIDER_LABELS[provider]} returned an invalid verification response`)
  }
  if (
    typeof payload?.access_token !== 'string'
    || payload.access_token.length < 8
  ) {
    fail(`${PROVIDER_LABELS[provider]} returned an invalid verification response`)
  }
  return true
}

async function loadOrganization(client, name) {
  const organizations = await client.query(
    `SELECT id::text, name, reference_code
     FROM workspace_organizations
     WHERE lower(name) = lower($1)
     ORDER BY id`,
    [name],
  )
  if (organizations.rowCount !== 1) {
    fail(`Expected exactly one ${name} organization`)
  }
  if (!UUID_PATTERN.test(organizations.rows[0].id)) {
    fail(`${name} organization identity is invalid`)
  }
  return organizations.rows[0]
}

async function loadDatabaseIdentity(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
       (
         SELECT value ->> 'id'
         FROM app_settings
         WHERE key = 'deployment.database.identity'
       ) AS database_fingerprint`,
  )
  const identity = result.rows[0]
  if (
    !UUID_PATTERN.test(identity?.database_fingerprint || '')
    || identity.database_fingerprint
      !== TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT
  ) {
    fail('Connected database is not the trusted ClawPilot development database')
  }
  return identity
}

async function loadTarget(client, lock = false) {
  const organization = await loadOrganization(
    client,
    TARGET_ORGANIZATION_NAME,
  )
  const warehouses = await client.query(
    `SELECT id::text, global_id, code, name, address, status
     FROM operations_warehouses
     WHERE organization_id = $1::uuid
     ORDER BY created_at, id
     ${lock ? 'FOR UPDATE' : ''}`,
    [organization.id],
  )
  if (
    warehouses.rowCount !== 1
    || warehouses.rows[0].status !== 'active'
    || warehouses.rows[0].code !== TARGET_WAREHOUSE_CODE
    || warehouses.rows[0].global_id !== TARGET_WAREHOUSE_GLOBAL_ID
  ) {
    fail(
      `AG Alchemy must have exactly one active ${TARGET_WAREHOUSE_CODE} warehouse `
      + `with Global ID ${TARGET_WAREHOUSE_GLOBAL_ID}`,
    )
  }
  const memberships = await client.query(
    `SELECT user_email
     FROM app_user_organization_memberships
     WHERE organization_id = $1::uuid
       AND status = 'active'
       AND role IN ('owner', 'admin')
     ORDER BY role = 'owner' DESC, user_email`,
    [organization.id],
  )
  if (memberships.rowCount !== 1) {
    fail('AG Alchemy must have exactly one active owner or admin')
  }
  return {
    organization,
    actorEmail: memberships.rows[0].user_email,
    warehouse: warehouses.rows[0],
    origin: normalizeCarrierAddress(warehouses.rows[0].address),
  }
}

function targetSnapshotDigest(target) {
  return stableDigest({
    organizationId: target.organization.id,
    organizationReference: target.organization.reference_code,
    actorEmail: target.actorEmail,
    warehouseId: target.warehouse.id,
    warehouseGlobalId: target.warehouse.global_id,
    warehouseCode: target.warehouse.code,
    warehouseName: target.warehouse.name,
    warehouseStatus: target.warehouse.status,
    origin: target.origin,
  })
}

async function loadSource(client, lock = false) {
  const organization = await loadOrganization(
    client,
    SOURCE_ORGANIZATION_NAME,
  )
  const result = await client.query(
    `SELECT
       account.organization_id::text,
       account.id::text AS integration_account_id,
       account.global_id AS integration_global_id,
       account.provider,
       account.integration_type,
       account.environment,
       account.display_name AS integration_display_name,
       account.status AS integration_status,
       account.configuration,
       account.credential_reference,
       account.created_by AS integration_created_by,
       account.updated_by AS integration_updated_by,
       account.created_at AS integration_created_at,
       account.updated_at AS integration_updated_at,
       credential.credential_ciphertext,
       credential.credential_iv,
       credential.credential_tag,
       credential.credential_version,
       credential.client_id_last_four,
       credential.account_number_last_four
         AS credential_account_number_last_four,
       credential.verification_status,
       credential.verified_at,
       credential.last_error_code AS credential_last_error_code,
       credential.created_by AS credential_created_by,
       credential.updated_by AS credential_updated_by,
       credential.created_at AS credential_created_at,
       credential.updated_at AS credential_updated_at,
       carrier_account.id::text AS carrier_account_id,
       carrier_account.global_id AS carrier_account_global_id,
       carrier_account.display_name AS carrier_account_display_name,
       carrier_account.sender_name,
       carrier_account.account_number_ciphertext,
       carrier_account.account_number_iv,
       carrier_account.account_number_tag,
       carrier_account.encryption_version AS carrier_account_encryption_version,
       carrier_account.account_number_last_four,
       carrier_account.account_number_fingerprint,
       carrier_account.registered_address,
       carrier_account.registered_address_fingerprint,
       carrier_account.address_verification,
       carrier_account.allow_sender_billing,
       carrier_account.allow_recipient_billing,
       carrier_account.allow_third_party_billing,
       carrier_account.status AS carrier_account_status,
       carrier_account.created_by AS carrier_account_created_by,
       carrier_account.updated_by AS carrier_account_updated_by,
       carrier_account.created_at AS carrier_account_created_at,
       carrier_account.updated_at AS carrier_account_updated_at
     FROM operations_integration_accounts account
     JOIN operations_carrier_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = account.organization_id
      AND carrier_account.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.environment = 'sandbox'
       AND account.provider = ANY($2::text[])
     ORDER BY account.provider, carrier_account.global_id
     ${lock ? 'FOR SHARE OF account, credential, carrier_account' : ''}`,
    [organization.id, EXPECTED_PROVIDERS],
  )
  if (
    result.rowCount !== EXPECTED_PROVIDERS.length
    || result.rows.some((row, index) => (
      row.provider !== EXPECTED_PROVIDERS[index]
      || row.environment !== 'sandbox'
      || row.integration_status !== 'active'
      || row.verification_status !== 'verified'
      || row.carrier_account_status !== 'active'
    ))
  ) {
    fail('EPISCS must have one active verified UPS and FedEx sandbox account')
  }
  return result.rows.map((row) => ({
    ...row,
    organization,
    credential: decryptSourceCredential(row),
    accountNumber: decryptSourceAccountNumber(row),
  }))
}

function sourceSnapshotDigest(rows) {
  return stableDigest(rows.map((row) => ({
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    integrationGlobalId: row.integration_global_id,
    provider: row.provider,
    integrationType: row.integration_type,
    environment: row.environment,
    integrationDisplayName: row.integration_display_name,
    integrationStatus: row.integration_status,
    integrationConfiguration: row.configuration,
    integrationCredentialReference: row.credential_reference,
    integrationCreatedBy: row.integration_created_by,
    integrationUpdatedBy: row.integration_updated_by,
    integrationCreatedAt: row.integration_created_at,
    integrationUpdatedAt: row.integration_updated_at,
    credentialVersion: row.credential_version,
    credentialClientIdLastFour: row.client_id_last_four,
    credentialAccountNumberLastFour:
      row.credential_account_number_last_four,
    credentialVerificationStatus: row.verification_status,
    credentialVerifiedAt: row.verified_at,
    credentialLastErrorCode: row.credential_last_error_code,
    credentialCreatedBy: row.credential_created_by,
    credentialUpdatedBy: row.credential_updated_by,
    credentialCreatedAt: row.credential_created_at,
    credentialUpdatedAt: row.credential_updated_at,
    credentialCiphertextHash: stableDigest(
      row.credential_ciphertext.toString('base64'),
    ),
    credentialIvHash: stableDigest(row.credential_iv.toString('base64')),
    credentialTagHash: stableDigest(row.credential_tag.toString('base64')),
    carrierAccountId: row.carrier_account_id,
    carrierAccountGlobalId: row.carrier_account_global_id,
    carrierAccountDisplayName: row.carrier_account_display_name,
    carrierAccountSenderName: row.sender_name,
    carrierAccountCiphertextHash: stableDigest(
      row.account_number_ciphertext,
    ),
    carrierAccountIvHash: stableDigest(row.account_number_iv),
    carrierAccountTagHash: stableDigest(row.account_number_tag),
    carrierAccountEncryptionVersion:
      row.carrier_account_encryption_version,
    carrierAccountLastFour: row.account_number_last_four,
    carrierAccountFingerprint: row.account_number_fingerprint,
    carrierAccountStatus: row.carrier_account_status,
    carrierAccountRegisteredAddress: row.registered_address,
    carrierAccountStoredAddressFingerprint:
      row.registered_address_fingerprint,
    addressVerification: row.address_verification,
    allowSenderBilling: row.allow_sender_billing,
    allowRecipientBilling: row.allow_recipient_billing,
    allowThirdPartyBilling: row.allow_third_party_billing,
    carrierAccountCreatedBy: row.carrier_account_created_by,
    carrierAccountUpdatedBy: row.carrier_account_updated_by,
    carrierAccountCreatedAt: row.carrier_account_created_at,
    carrierAccountUpdatedAt: row.carrier_account_updated_at,
    registeredAddressFingerprint: addressFingerprint(
      row.registered_address,
    ),
  })))
}

async function loadTargetConnections(client, organizationId, lock = false) {
  const result = await client.query(
    `SELECT
       account.organization_id::text,
       account.id::text AS integration_account_id,
       account.global_id AS integration_global_id,
       account.provider,
       account.environment,
       account.display_name AS integration_display_name,
       account.status AS integration_status,
       account.configuration,
       credential.credential_ciphertext,
       credential.credential_iv,
       credential.credential_tag,
       credential.credential_version,
       credential.verification_status,
       carrier_account.id::text AS carrier_account_id,
       carrier_account.global_id AS carrier_account_global_id,
       carrier_account.display_name AS carrier_account_display_name,
       carrier_account.sender_name,
       carrier_account.account_number_ciphertext,
       carrier_account.account_number_iv,
       carrier_account.account_number_tag,
       carrier_account.encryption_version,
       carrier_account.account_number_fingerprint,
       carrier_account.registered_address,
       carrier_account.registered_address_fingerprint,
       carrier_account.address_verification,
       carrier_account.allow_sender_billing,
       carrier_account.allow_recipient_billing,
       carrier_account.allow_third_party_billing,
       carrier_account.status AS carrier_account_status
     FROM operations_integration_accounts account
     LEFT JOIN operations_carrier_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     LEFT JOIN operations_carrier_accounts carrier_account
       ON carrier_account.organization_id = account.organization_id
      AND carrier_account.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'carrier'
       AND account.environment = 'sandbox'
       AND account.provider = ANY($2::text[])
     ORDER BY account.provider, carrier_account.global_id
     ${lock ? 'FOR UPDATE OF account' : ''}`,
    [organizationId, EXPECTED_PROVIDERS],
  )
  const providers = new Map()
  for (const row of result.rows) {
    if (providers.has(row.provider)) {
      fail(`AG Alchemy has more than one ${row.provider} sandbox carrier account`)
    }
    providers.set(row.provider, row)
  }
  return providers
}

function targetDisposition(source, target, targetContext) {
  if (!target) {
    return {
      action: 'create',
      targetIntegrationGlobalId: null,
      targetCarrierAccountGlobalId: null,
    }
  }
  if (target.configuration?.managedBy !== MANAGED_BY) {
    fail(`AG Alchemy already has an unmanaged ${source.provider} sandbox connection`)
  }
  if (
    !target.credential_ciphertext
    || !target.carrier_account_global_id
  ) {
    fail(`The managed AG Alchemy ${source.provider} sandbox connection is incomplete`)
  }
  const expectedCredential = source.credential
  const targetCredential = decryptTargetCredential(target)
  const expectedAccountNumber = source.accountNumber
  const targetAccountNumber = decryptTargetAccountNumber(target)
  const expectedConfig = expectedConfiguration(source, targetContext)
  const exact = (
    target.integration_status === 'active'
    && target.verification_status === 'verified'
    && target.carrier_account_status === 'active'
    && targetCredential.clientId === expectedCredential.clientId
    && targetCredential.clientSecret === expectedCredential.clientSecret
    && targetCredential.accountNumber === null
    && targetAccountNumber === expectedAccountNumber
    && sameAddress(target.registered_address, targetContext.origin)
    && target.sender_name === targetContext.warehouse.name
    && target.allow_sender_billing === true
    && target.allow_recipient_billing === false
    && target.allow_third_party_billing === false
    && sameConfiguration(target.configuration, expectedConfig)
  )
  return {
    action: exact ? 'noop' : 'update',
    targetIntegrationGlobalId: target.integration_global_id,
    targetCarrierAccountGlobalId: target.carrier_account_global_id,
  }
}

async function auditDelegation(client, input) {
  await client.query(
    `INSERT INTO audit_events (
       actor, event_type, aggregate_type, aggregate_id, payload, event_key,
       subject, organization_id, is_system
     ) VALUES (
       $1, $2, 'carrier_integration', $3, $4::jsonb, $5, $6, $7::uuid, false
     )
     ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    [
      input.actorEmail,
      input.eventType,
      input.targetIntegrationGlobalId,
      JSON.stringify({
        provider: input.source.provider,
        environment: 'sandbox',
        sourceOrganizationReferenceCode:
          input.source.organization.reference_code,
        sourceIntegrationGlobalId: input.source.integration_global_id,
        sourceCarrierAccountGlobalId:
          input.source.carrier_account_global_id,
        senderOriginWarehouseGlobalId:
          input.target.warehouse.global_id,
        allowedCapabilities: ['sandbox_rate'],
        credentialRevealAllowed: false,
        scriptVersion: SCRIPT_VERSION,
      }),
      [
        'carrier-sandbox-delegation',
        input.targetIntegrationGlobalId,
        input.source.credential_version,
        addressFingerprint(input.target.origin),
      ].join(':'),
      `${PROVIDER_LABELS[input.source.provider]} sandbox rating`,
      input.target.organization.id,
    ],
  )
}

async function createTargetConnection(client, source, target) {
  const configuration = expectedConfiguration(source, target)
  const integration = await client.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment, display_name,
       status, configuration, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'carrier', 'sandbox', $3, 'active', $4::jsonb, $5, $5
     )
     RETURNING id::text, global_id`,
    [
      target.organization.id,
      source.provider,
      `${PROVIDER_LABELS[source.provider]} sandbox rating via EPISCS`,
      JSON.stringify(configuration),
      target.actorEmail,
    ],
  )
  const integrationRow = integration.rows[0]
  const credential = encryptJson(
    source.credential,
    credentialAad(target.organization.id, source.provider),
  )
  await client.query(
    `INSERT INTO operations_carrier_credentials (
       organization_id, integration_account_id,
       credential_ciphertext, credential_iv, credential_tag,
       credential_version, client_id_last_four, account_number_last_four,
       verification_status, verified_at, last_error_code, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, 1, $6, NULL,
       'verified', now(), NULL, $7, $7
     )`,
    [
      target.organization.id,
      integrationRow.id,
      credential.ciphertext,
      credential.iv,
      credential.tag,
      source.credential.clientId.slice(-4),
      target.actorEmail,
    ],
  )
  await client.query(
    `UPDATE operations_integration_accounts
     SET credential_reference = $3, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [
      target.organization.id,
      integrationRow.id,
      `carrier-credential:${integrationRow.id}:v1`,
    ],
  )
  const carrierGlobalId = (
    await client.query(
      `SELECT allocate_global_reference('gac') AS global_id`,
    )
  ).rows[0].global_id
  const encryptedAccount = encryptText(
    source.accountNumber,
    carrierAccountAad(
      target.organization.id,
      source.provider,
      carrierGlobalId,
    ),
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       global_id, organization_id, integration_account_id,
       display_name, sender_name,
       account_number_ciphertext, account_number_iv, account_number_tag,
       encryption_version, account_number_last_four,
       account_number_fingerprint, registered_address,
       registered_address_fingerprint, address_verification,
       allow_sender_billing, allow_recipient_billing,
       allow_third_party_billing, status, created_by, updated_by
     ) VALUES (
       $1, $2::uuid, $3::uuid, $4, $5,
       $6, $7, $8, 1, $9, $10, $11::jsonb, $12,
       'operator_attested', true, false, false, 'active', $13, $13
     )`,
    [
      carrierGlobalId,
      target.organization.id,
      integrationRow.id,
      `${PROVIDER_LABELS[source.provider]} sandbox rating account`,
      target.warehouse.name,
      encryptedAccount.ciphertext.toString('base64'),
      encryptedAccount.iv.toString('base64'),
      encryptedAccount.tag.toString('base64'),
      source.accountNumber.slice(-4),
      accountNumberFingerprint(
        target.organization.id,
        source.provider,
        source.accountNumber,
      ),
      JSON.stringify(target.origin),
      addressFingerprint(target.origin),
      target.actorEmail,
    ],
  )
  await auditDelegation(client, {
    actorEmail: target.actorEmail,
    eventType: 'carrier.sandbox_rating_delegation.created',
    source,
    target,
    targetIntegrationGlobalId: integrationRow.global_id,
  })
}

async function updateTargetConnection(client, source, target, existing) {
  const configuration = expectedConfiguration(source, target)
  const targetCredential = decryptTargetCredential(existing)
  const credentialChanged = (
    targetCredential.clientId !== source.credential.clientId
    || targetCredential.clientSecret !== source.credential.clientSecret
    || targetCredential.accountNumber !== null
  )
  const targetAccountNumber = decryptTargetAccountNumber(existing)
  const accountNumberChanged = targetAccountNumber !== source.accountNumber
  let credentialVersion = existing.credential_version
  if (credentialChanged) {
    const encrypted = encryptJson(
      source.credential,
      credentialAad(target.organization.id, source.provider),
    )
    const updated = await client.query(
      `UPDATE operations_carrier_credentials
       SET credential_ciphertext = $3,
           credential_iv = $4,
           credential_tag = $5,
           credential_version = credential_version + 1,
           client_id_last_four = $6,
           account_number_last_four = NULL,
           verification_status = 'verified',
           verified_at = now(),
           last_error_code = NULL,
           updated_by = $7,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
       RETURNING credential_version`,
      [
        target.organization.id,
        existing.integration_account_id,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        source.credential.clientId.slice(-4),
        target.actorEmail,
      ],
    )
    credentialVersion = updated.rows[0].credential_version
  }
  await client.query(
    `UPDATE operations_integration_accounts
     SET display_name = $3,
         status = 'active',
         configuration = $4::jsonb,
         credential_reference = $5,
         updated_by = $6,
         updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [
      target.organization.id,
      existing.integration_account_id,
      `${PROVIDER_LABELS[source.provider]} sandbox rating via EPISCS`,
      JSON.stringify(configuration),
      `carrier-credential:${existing.integration_account_id}:v${credentialVersion}`,
      target.actorEmail,
    ],
  )
  let encryptedAccount = null
  if (accountNumberChanged) {
    encryptedAccount = encryptText(
      source.accountNumber,
      carrierAccountAad(
        target.organization.id,
        source.provider,
        existing.carrier_account_global_id,
      ),
    )
  }
  await client.query(
    `UPDATE operations_carrier_accounts
     SET display_name = $3,
         sender_name = $4,
         account_number_ciphertext =
           COALESCE($5, account_number_ciphertext),
         account_number_iv = COALESCE($6, account_number_iv),
         account_number_tag = COALESCE($7, account_number_tag),
         encryption_version = CASE
           WHEN $5::text IS NULL THEN encryption_version
           ELSE encryption_version + 1
         END,
         account_number_last_four = $8,
         account_number_fingerprint = $9,
         registered_address = $10::jsonb,
         registered_address_fingerprint = $11,
         address_verification = 'operator_attested',
         allow_sender_billing = true,
         allow_recipient_billing = false,
         allow_third_party_billing = false,
         status = 'active',
         updated_by = $12,
         updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [
      target.organization.id,
      existing.carrier_account_id,
      `${PROVIDER_LABELS[source.provider]} sandbox rating account`,
      target.warehouse.name,
      encryptedAccount?.ciphertext.toString('base64') || null,
      encryptedAccount?.iv.toString('base64') || null,
      encryptedAccount?.tag.toString('base64') || null,
      source.accountNumber.slice(-4),
      accountNumberFingerprint(
        target.organization.id,
        source.provider,
        source.accountNumber,
      ),
      JSON.stringify(target.origin),
      addressFingerprint(target.origin),
      target.actorEmail,
    ],
  )
  await auditDelegation(client, {
    actorEmail: target.actorEmail,
    eventType: 'carrier.sandbox_rating_delegation.updated',
    source,
    target,
    targetIntegrationGlobalId: existing.integration_global_id,
  })
}

async function provision(client, sourceRows, target, apply) {
  const existing = await loadTargetConnections(
    client,
    target.organization.id,
  )
  const planned = sourceRows.map((source) => ({
    source,
    ...targetDisposition(source, existing.get(source.provider), target),
  }))
  if (!apply) {
    return planned
  }

  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [`carrier-sandbox-delegation:${target.organization.id}`],
    )
    for (const provider of EXPECTED_PROVIDERS) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [
          `carrier-credential:${target.organization.id}:${provider}:sandbox`,
        ],
      )
    }
    const lockedTarget = await loadTarget(client, true)
    if (targetSnapshotDigest(lockedTarget) !== targetSnapshotDigest(target)) {
      fail('AG Alchemy warehouse or administrator changed after planning')
    }
    const lockedSourceRows = await loadSource(client, true)
    if (
      sourceSnapshotDigest(lockedSourceRows)
      !== sourceSnapshotDigest(sourceRows)
    ) {
      fail('EPISCS carrier credentials changed after provider verification')
    }
    const lockedExisting = await loadTargetConnections(
      client,
      target.organization.id,
      true,
    )
    for (const source of lockedSourceRows) {
      const locked = lockedExisting.get(source.provider)
      const disposition = targetDisposition(source, locked, lockedTarget)
      if (disposition.action === 'create') {
        await createTargetConnection(client, source, lockedTarget)
      } else if (disposition.action === 'update') {
        await updateTargetConnection(
          client,
          source,
          lockedTarget,
          locked,
        )
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }

  const postflight = await loadTargetConnections(
    client,
    target.organization.id,
  )
  return sourceRows.map((source) => {
    const row = postflight.get(source.provider)
    const disposition = targetDisposition(source, row, target)
    if (disposition.action !== 'noop') {
      fail(`AG Alchemy ${source.provider} sandbox postflight failed`)
    }
    return {
      source,
      action: planned.find(
        (entry) => entry.source.provider === source.provider,
      ).action,
      targetIntegrationGlobalId: row.integration_global_id,
      targetCarrierAccountGlobalId: row.carrier_account_global_id,
    }
  })
}

export async function run({ apply = false, pool = null } = {}) {
  requireTrustedDevelopmentEnvironment()
  const databaseUrl = environmentValue('DATABASE_URL')
  if (!databaseUrl) fail('DATABASE_URL is required')
  const normalizedDatabaseUrl = new URL(databaseUrl)
  normalizedDatabaseUrl.searchParams.delete('sslmode')
  const ownedPool = pool || new Pool({
    connectionString: normalizedDatabaseUrl.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
  })
  const client = await ownedPool.connect()
  try {
    const database = await loadDatabaseIdentity(client)
    const [sourceRows, target] = await Promise.all([
      loadSource(client),
      loadTarget(client),
    ])
    const sourceBefore = sourceSnapshotDigest(sourceRows)
    await Promise.all(sourceRows.map((source) => (
      verifySandboxCredential(source.provider, source.credential)
    )))
    const result = await provision(client, sourceRows, target, apply)
    const sourceAfter = sourceSnapshotDigest(await loadSource(client))
    if (sourceAfter !== sourceBefore) {
      fail('EPISCS source carrier records changed during delegation')
    }
    return {
      ok: true,
      scriptVersion: SCRIPT_VERSION,
      mode: apply ? 'apply' : 'plan',
      database: {
        fingerprint: database.database_fingerprint,
        trustedDevelopmentDatabase: true,
      },
      sourceOrganization: {
        name: sourceRows[0].organization.name,
        referenceCode: sourceRows[0].organization.reference_code,
        stateDigest: sourceBefore,
        unchanged: true,
      },
      targetOrganization: {
        name: target.organization.name,
        referenceCode: target.organization.reference_code,
      },
      senderOrigin: {
        warehouseGlobalId: target.warehouse.global_id,
        warehouseCode: target.warehouse.code,
        warehouseCount: 1,
        name: target.warehouse.name,
        address: target.origin,
      },
      providers: result.map((entry) => ({
        provider: entry.source.provider,
        environment: 'sandbox',
        sourceIntegrationGlobalId:
          entry.source.integration_global_id,
        sourceCarrierAccountGlobalId:
          entry.source.carrier_account_global_id,
        targetIntegrationGlobalId:
          entry.targetIntegrationGlobalId,
        targetCarrierAccountGlobalId:
          entry.targetCarrierAccountGlobalId,
        action: entry.action,
        credentialVerified: true,
        allowedCapabilities: ['sandbox_rate'],
        credentialRevealAllowed: false,
      })),
      providerWrites: 0,
      labelsCreated: 0,
    }
  } finally {
    client.release()
    if (!pool) await ownedPool.end()
  }
}

function selfTest() {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY ||=
    'ag-alchemy-carrier-sandbox-self-test-key-0123456789'
  const sourceOrganizationId = '11111111-1111-4111-8111-111111111111'
  const targetOrganizationId = '22222222-2222-4222-8222-222222222222'
  const provider = 'ups_rest'
  const credential = {
    clientId: 'self-test-client',
    clientSecret: 'self-test-secret-value',
    accountNumber: null,
  }
  const encryptedCredential = encryptJson(
    credential,
    credentialAad(targetOrganizationId, provider),
  )
  const credentialRoundTrip = decryptJson(
    encryptedCredential,
    credentialAad(targetOrganizationId, provider),
    'Self-test credential',
  )
  if (
    credentialRoundTrip.clientId !== credential.clientId
    || credentialRoundTrip.clientSecret !== credential.clientSecret
    || credentialRoundTrip.accountNumber !== null
  ) {
    fail('Credential re-encryption self-test failed')
  }
  let crossOrganizationRejected = false
  try {
    decryptJson(
      encryptedCredential,
      credentialAad(sourceOrganizationId, provider),
      'Self-test cross-organization credential',
    )
  } catch {
    crossOrganizationRejected = true
  }
  if (!crossOrganizationRejected) {
    fail('Cross-organization credential AAD self-test failed')
  }
  const carrierAccountGlobalId = 'gac1234567'
  const encryptedAccount = encryptText(
    'ABC1234',
    carrierAccountAad(
      targetOrganizationId,
      provider,
      carrierAccountGlobalId,
    ),
  )
  if (
    decryptText(
      encryptedAccount,
      carrierAccountAad(
        targetOrganizationId,
        provider,
        carrierAccountGlobalId,
      ),
      'Self-test carrier account',
    ) !== 'ABC1234'
  ) {
    fail('Carrier account re-encryption self-test failed')
  }
  const address = normalizeCarrierAddress({
    line1: '7009 S 108th St',
    city: 'La Vista',
    region: 'NE',
    postalCode: '68128',
    country: 'US',
  })
  if (
    address.countryCode !== 'US'
    || addressFingerprint(address).length !== 64
  ) {
    fail('AG warehouse origin self-test failed')
  }
  return {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    providers: [...EXPECTED_PROVIDERS],
    allowedCapabilities: ['sandbox_rate'],
    credentialRevealAllowed: false,
    oneWarehouseRequired: true,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const selfTestOnly = process.argv.includes('--self-test')
  if (selfTestOnly) {
    console.log(JSON.stringify(selfTest(), null, 2))
  } else {
    const apply = process.argv.includes('--apply')
    if (apply) {
      const confirmation = process.argv.find((value) => (
        value.startsWith('--confirm=')
      ))?.slice('--confirm='.length)
      if (confirmation !== EXECUTION_CONFIRMATION) {
        fail(`Apply requires --confirm=${EXECUTION_CONFIRMATION}`)
      }
    }
    console.log(JSON.stringify(await run({ apply }), null, 2))
  }
}
