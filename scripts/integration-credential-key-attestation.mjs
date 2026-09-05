#!/usr/bin/env node

import { createDecipheriv, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERSION,
  createIntegrationCredentialKeyAttestation,
  deriveIntegrationCredentialEncryptionKey,
  normalizeIntegrationCredentialDatabaseIdentity,
  resolveIntegrationCredentialEncryptionKeyConfig,
  verifyIntegrationCredentialKeyAttestation,
  verifyIntegrationCredentialKeyAttestationRecord,
} from '../app_src/lib/integrations/integrationCredentialKeyAttestation.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

export const INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_FORMAT =
  'clawpilot-integration-credential-key-adoption-plan-v1'
export const INTEGRATION_CREDENTIAL_KEY_ATTESTATION_LOCK =
  'clawpilot:integration-credential-key-attestation:v1'
export const INTEGRATION_CREDENTIAL_KEY_REVIEWED_ADOPTION_INSTALL_CONTEXT =
  'clawpilot.integration_credential_key_attestation_reviewed_adoption_install_context'
export const INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_MAX_AGE_MS =
  30 * 60 * 1000

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const ADOPTION_LOCK_TABLES = Object.freeze([
  // These two identity sources supply authenticated-data fields for protected
  // commerce rows and therefore must not drift while a proof is assembled.
  'operations_integration_accounts',
  'operations_orders',
  'operations_carrier_accounts',
  'operations_carrier_credentials',
  'operations_commerce_credentials',
  'operations_commerce_intake_continuations',
  'operations_commerce_intake_read_intents',
  'operations_commerce_oauth_installations',
  'operations_commerce_order_candidates',
  'operations_commerce_order_workbench',
  'operations_commerce_webhook_receipts',
  'operations_order_shipment_address_working_copies',
])

export class IntegrationCredentialKeyAttestationOperatorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'IntegrationCredentialKeyAttestationOperatorError'
    this.code = code
  }
}

function operatorError(code, message) {
  return new IntegrationCredentialKeyAttestationOperatorError(code, message)
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeActor(value) {
  const actor = String(value || '').trim().toLowerCase()
  if (!EMAIL_PATTERN.test(actor) || actor.length > 320) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_ACTOR_INVALID',
      'A valid attestation operator email is required',
    )
  }
  return actor
}

function safeBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw operatorError(
    'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
    'Legacy integration credential evidence could not be authenticated',
  )
}

function decodeBase64(value) {
  const encoded = String(value || '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
      'Legacy integration credential evidence could not be authenticated',
    )
  }
  return Buffer.from(encoded, 'base64')
}

function decryptAesGcm(key, ciphertext, iv, tag, aad) {
  const chunks = []
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    chunks.push(decipher.update(ciphertext))
    chunks.push(decipher.final())
    return Buffer.concat(chunks)
  } catch {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
      'Legacy integration credential evidence could not be authenticated',
    )
  } finally {
    chunks.forEach((chunk) => chunk.fill(0))
  }
}

function parseCredentialObject(payload) {
  try {
    const value = JSON.parse(payload.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid')
    }
    return value
  } catch {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
      'Legacy integration credential evidence could not be authenticated',
    )
  } finally {
    payload.fill(0)
  }
}

function adoptionProofFailed() {
  return operatorError(
    'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
    'Legacy integration credential evidence could not be authenticated',
  )
}

function authenticateOpaquePayload(key, row, aad, minimumBytes, maximumBytes) {
  const plaintext = decryptAesGcm(
    key,
    safeBuffer(row.ciphertext),
    safeBuffer(row.iv),
    safeBuffer(row.tag),
    aad,
  )
  try {
    if (
      plaintext.byteLength < minimumBytes
      || plaintext.byteLength > maximumBytes
    ) {
      throw adoptionProofFailed()
    }
  } finally {
    plaintext.fill(0)
  }
}

function credentialEvidenceDigest(rows) {
  return sha256(canonicalJson(rows.map((row) => ({
    identity: String(row.row_identity),
    ciphertextDigest: String(row.ciphertext_digest),
  })).sort((left, right) => (
    left.identity.localeCompare(right.identity)
    || left.ciphertextDigest.localeCompare(right.ciphertextDigest)
  ))))
}

const FOOTPRINT_QUERIES = Object.freeze([
  Object.freeze({
    store: 'operations_commerce_credentials',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'commerce-credential', credential.organization_id::text,
                   account.provider, account.environment,
                   credential.external_account_id,
                   credential.credential_version
                 )::text AS row_identity,
                 encode(digest(credential.credential_ciphertext
                               || credential.credential_iv
                               || credential.credential_tag, 'sha256'), 'hex')
                   AS ciphertext_digest
                 , credential.organization_id::text AS organization_id
                 , account.provider, account.environment
                 , credential.external_account_id
                 , credential.credential_ciphertext AS ciphertext
                 , credential.credential_iv AS iv
                 , credential.credential_tag AS tag
          FROM operations_commerce_credentials credential
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = credential.organization_id
           AND account.id = credential.integration_account_id`,
  }),
  Object.freeze({
    store: 'operations_carrier_credentials',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'carrier-credential', credential.organization_id::text,
                   account.provider, account.environment,
                   credential.credential_version
                 )::text AS row_identity,
                 encode(digest(credential.credential_ciphertext
                               || credential.credential_iv
                               || credential.credential_tag, 'sha256'), 'hex')
                   AS ciphertext_digest
                 , credential.organization_id::text AS organization_id
                 , account.provider, account.environment
                 , credential.credential_ciphertext AS ciphertext
                 , credential.credential_iv AS iv
                 , credential.credential_tag AS tag
          FROM operations_carrier_credentials credential
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = credential.organization_id
           AND account.id = credential.integration_account_id`,
  }),
  Object.freeze({
    store: 'operations_carrier_accounts',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'carrier-account', carrier_account.organization_id::text,
                   account.provider, account.environment,
                   carrier_account.global_id,
                   carrier_account.encryption_version
                 )::text AS row_identity,
                 encode(digest(convert_to(
                   carrier_account.account_number_ciphertext || ':'
                   || carrier_account.account_number_iv || ':'
                   || carrier_account.account_number_tag,
                   'UTF8'
                 ), 'sha256'), 'hex')
                   AS ciphertext_digest
                 , carrier_account.organization_id::text AS organization_id
                 , carrier_account.global_id
                 , account.provider, account.environment
                 , carrier_account.account_number_ciphertext AS ciphertext
                 , carrier_account.account_number_iv AS iv
                 , carrier_account.account_number_tag AS tag
          FROM operations_carrier_accounts carrier_account
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = carrier_account.organization_id
           AND account.id = carrier_account.integration_account_id`,
  }),
  Object.freeze({
    store: 'operations_commerce_oauth_installations',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'commerce-oauth-installation', organization_id::text,
                   'faire', browser_session_id::text, state_hash
                 )::text AS row_identity,
                 encode(digest(application_credential_ciphertext
                               || application_credential_iv
                               || application_credential_tag,
                               'sha256'), 'hex') AS ciphertext_digest
                 , organization_id::text AS organization_id
                 , browser_session_id::text AS browser_session_id
                 , state_hash
                 , application_credential_ciphertext AS ciphertext
                 , application_credential_iv AS iv
                 , application_credential_tag AS tag
          FROM operations_commerce_oauth_installations
          WHERE application_credential_ciphertext IS NOT NULL`,
  }),
  Object.freeze({
    store: 'operations_commerce_webhook_receipts',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'commerce-webhook', account.global_id,
                   receipt.provider, receipt.provider_event_id, receipt.topic
                 )::text AS row_identity,
                 encode(digest(receipt.payload_ciphertext || receipt.payload_iv
                               || receipt.payload_tag, 'sha256'), 'hex')
                   AS ciphertext_digest
                 , account.global_id AS account_global_id
                 , receipt.provider, receipt.provider_event_id, receipt.topic
                 , receipt.payload_ciphertext AS ciphertext
                 , receipt.payload_iv AS iv, receipt.payload_tag AS tag
          FROM operations_commerce_webhook_receipts receipt
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = receipt.organization_id
           AND account.id = receipt.integration_account_id
          WHERE receipt.payload_ciphertext IS NOT NULL`,
  }),
  Object.freeze({
    store: 'operations_commerce_order_candidates',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'commerce-candidate-snapshot',
                   snapshot.organization_id::text, account.global_id,
                   snapshot.external_order_id, snapshot.source_hash,
                   snapshot.kind
                 )::text AS row_identity,
                 encode(digest(snapshot.ciphertext || snapshot.iv
                               || snapshot.tag, 'sha256'), 'hex')
                   AS ciphertext_digest
                 , snapshot.organization_id::text AS organization_id
                 , account.global_id AS account_global_id
                 , snapshot.external_order_id, snapshot.source_hash
                 , snapshot.kind, snapshot.ciphertext
                 , snapshot.iv, snapshot.tag
          FROM (
            SELECT organization_id, integration_account_id,
                   external_order_id, source_hash,
                   'party'::text AS kind,
                   party_snapshot_ciphertext AS ciphertext,
                   party_snapshot_iv AS iv, party_snapshot_tag AS tag
            FROM operations_commerce_order_candidates
            WHERE party_snapshot_ciphertext IS NOT NULL
            UNION ALL
            SELECT organization_id, integration_account_id,
                   external_order_id, source_hash,
                   'ship_to'::text AS kind,
                   ship_to_snapshot_ciphertext AS ciphertext,
                   ship_to_snapshot_iv AS iv, ship_to_snapshot_tag AS tag
            FROM operations_commerce_order_candidates
            WHERE ship_to_snapshot_ciphertext IS NOT NULL
          ) snapshot
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = snapshot.organization_id
           AND account.id = snapshot.integration_account_id`,
  }),
  Object.freeze({
    store: 'operations_commerce_intake_read_intents',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'commerce-intake-read-result', intent.organization_id::text,
                   account.global_id, intent.provider, intent.id::text,
                   intent.provider_attempt_id::text, intent.request_hash
                 )::text AS row_identity,
                 encode(digest(intent.response_ciphertext || intent.response_iv
                               || intent.response_tag, 'sha256'), 'hex')
                   AS ciphertext_digest
                 , intent.organization_id::text AS organization_id
                 , account.global_id AS account_global_id
                 , intent.provider, intent.id::text AS intent_id
                 , intent.provider_attempt_id::text AS provider_attempt_id
                 , intent.request_hash
                 , intent.response_ciphertext AS ciphertext
                 , intent.response_iv AS iv, intent.response_tag AS tag
          FROM operations_commerce_intake_read_intents intent
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = intent.organization_id
           AND account.id = intent.integration_account_id
          WHERE intent.response_ciphertext IS NOT NULL`,
  }),
  Object.freeze({
    store: 'operations_commerce_intake_continuations',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'commerce-intake-continuation',
                   continuation.organization_id::text, account.global_id,
                   continuation.provider, continuation.session_id::text,
                   continuation.batch_number, continuation.query_hash
                 )::text AS row_identity,
                 encode(digest(continuation.cursor_ciphertext
                               || continuation.cursor_iv
                               || continuation.cursor_tag, 'sha256'), 'hex')
                   AS ciphertext_digest
                 , continuation.organization_id::text AS organization_id
                 , account.global_id AS account_global_id
                 , continuation.provider
                 , continuation.session_id::text AS session_id
                 , continuation.batch_number, continuation.query_hash
                 , continuation.cursor_ciphertext AS ciphertext
                 , continuation.cursor_iv AS iv, continuation.cursor_tag AS tag
          FROM operations_commerce_intake_continuations continuation
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = continuation.organization_id
           AND account.id = continuation.integration_account_id
          WHERE continuation.cursor_ciphertext IS NOT NULL`,
  }),
  Object.freeze({
    store: 'operations_commerce_order_workbench',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'commerce-workbench-ship-to', workbench.organization_id::text,
                   account.global_id, workbench.external_order_id,
                   workbench.ship_to_source_hash, 'ship_to'
                 )::text AS row_identity,
                 encode(digest(workbench.ship_to_ciphertext
                               || workbench.ship_to_iv
                               || workbench.ship_to_tag, 'sha256'), 'hex')
                   AS ciphertext_digest
                 , workbench.organization_id::text AS organization_id
                 , account.global_id AS account_global_id
                 , workbench.external_order_id
                 , workbench.ship_to_source_hash AS source_hash
                 , 'ship_to'::text AS kind
                 , workbench.ship_to_ciphertext AS ciphertext
                 , workbench.ship_to_iv AS iv, workbench.ship_to_tag AS tag
          FROM operations_commerce_order_workbench workbench
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = workbench.organization_id
           AND account.id = workbench.integration_account_id
          WHERE workbench.ship_to_ciphertext IS NOT NULL`,
  }),
  Object.freeze({
    store: 'operations_order_shipment_address_working_copies',
    anchor: true,
    sql: `SELECT jsonb_build_array(
                   'order-shipment-address-working-copy',
                   working_copy.organization_id::text, account.global_id,
                   source_order.external_order_id,
                   working_copy.source_order_hash, 'ship_to'
                 )::text AS row_identity,
                 encode(digest(working_copy.ship_to_ciphertext
                               || working_copy.ship_to_iv
                               || working_copy.ship_to_tag, 'sha256'), 'hex')
                   AS ciphertext_digest
                 , working_copy.organization_id::text AS organization_id
                 , account.global_id AS account_global_id
                 , source_order.external_order_id
                 , working_copy.source_order_hash AS source_hash
                 , 'ship_to'::text AS kind
                 , working_copy.ship_to_ciphertext AS ciphertext
                 , working_copy.ship_to_iv AS iv, working_copy.ship_to_tag AS tag
          FROM operations_order_shipment_address_working_copies working_copy
          LEFT JOIN operations_orders source_order
            ON source_order.organization_id = working_copy.organization_id
           AND source_order.id = working_copy.order_id
          LEFT JOIN operations_integration_accounts account
            ON account.organization_id = source_order.organization_id
           AND account.id = source_order.integration_account_id
          WHERE working_copy.ship_to_ciphertext IS NOT NULL`,
  }),
])

async function lockIntegrationCredentialKeyBackedStores(client) {
  await client.query(
    `LOCK TABLE ${ADOPTION_LOCK_TABLES.join(', ')} IN SHARE MODE`,
  )
}

export async function readIntegrationCredentialKeyBackedFootprint(client) {
  const stores = []
  for (const descriptor of FOOTPRINT_QUERIES) {
    const result = await client.query(descriptor.sql)
    for (const row of result.rows) {
      if (!SHA256_PATTERN.test(String(row.ciphertext_digest || ''))) {
        throw operatorError(
          'INTEGRATION_CREDENTIAL_KEY_FOOTPRINT_INVALID',
          'Integration credential key-backed footprint is invalid',
        )
      }
    }
    stores.push(Object.freeze({
      store: descriptor.store,
      anchor: descriptor.anchor,
      count: result.rows.length,
      digest: credentialEvidenceDigest(result.rows),
    }))
  }
  const total = stores.reduce((sum, store) => sum + store.count, 0)
  const anchorCount = stores.reduce(
    (sum, store) => sum + (store.anchor ? store.count : 0),
    0,
  )
  return Object.freeze({
    total,
    anchorCount,
    stores: Object.freeze(stores),
    digest: sha256(canonicalJson(stores)),
  })
}

export async function readIntegrationCredentialDatabaseIdentity(client) {
  const result = await client.query(
    `SELECT value->>'id' AS database_identity
     FROM app_settings
     WHERE key = 'deployment.database.identity'`,
  )
  if (result.rows.length !== 1) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_DATABASE_IDENTITY_INVALID',
      'Deployment database identity is missing or invalid',
    )
  }
  try {
    return normalizeIntegrationCredentialDatabaseIdentity(
      result.rows[0].database_identity,
    )
  } catch {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_DATABASE_IDENTITY_INVALID',
      'Deployment database identity is missing or invalid',
    )
  }
}

async function requireExpectedDatabaseIdentity(client, expectedValue) {
  const expected = normalizeIntegrationCredentialDatabaseIdentity(expectedValue)
  const actual = await readIntegrationCredentialDatabaseIdentity(client)
  if (actual !== expected) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_DATABASE_IDENTITY_MISMATCH',
      'Connected database does not match the expected deployment identity',
    )
  }
  return actual
}

async function ensureActorAuthorized(client, actor) {
  const result = await client.query(
    `SELECT status, role
     FROM app_users
     WHERE email = $1
     LIMIT 1
     FOR UPDATE`,
    [actor],
  )
  const authorized = result.rows.length === 1
    && result.rows[0].status === 'active'
    && ['owner', 'admin'].includes(result.rows[0].role)
  if (!authorized) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_ACTOR_UNAUTHORIZED',
      'Attestation operator must be an active owner or admin',
    )
  }
}

async function readAttestationRecord(client) {
  const result = await client.query(
    `SELECT singleton_id, attestation_version,
            database_identity::text AS database_identity, key_id,
            sentinel_ciphertext, sentinel_iv, sentinel_tag,
            bootstrap_mode, adoption_evidence_sha256,
            created_by, created_at
     FROM operations_integration_credential_key_attestations
     WHERE singleton_id = 1`,
  )
  return result.rows[0] || null
}

export async function authenticateLegacyIntegrationCredentialAnchors(
  client,
  keyMaterial,
) {
  const key = deriveIntegrationCredentialEncryptionKey(keyMaterial)
  let validated = 0
  try {
    for (const descriptor of FOOTPRINT_QUERIES) {
      const result = await client.query(descriptor.sql)
      for (const row of result.rows) {
        if (descriptor.store === 'operations_commerce_credentials') {
          if (!['shopify', 'faire'].includes(row.provider)) {
            throw adoptionProofFailed()
          }
          const payload = parseCredentialObject(decryptAesGcm(
            key,
            safeBuffer(row.ciphertext),
            safeBuffer(row.iv),
            safeBuffer(row.tag),
            `clawpilot:commerce:${row.organization_id}:${row.provider}:${row.environment}:${row.external_account_id}:credential:v1`,
          ))
          if (payload.provider !== row.provider) {
            throw adoptionProofFailed()
          }
        } else if (descriptor.store === 'operations_carrier_credentials') {
          const prefix = ['ups_rest', 'fedex_rest', 'usps_rest']
            .includes(row.provider)
            ? 'clawpilot:carrier'
            : ['wwex_speedship', 'rl_carriers'].includes(row.provider)
              ? 'clawpilot:brokered-transport'
              : null
          if (!prefix) throw adoptionProofFailed()
          parseCredentialObject(decryptAesGcm(
            key,
            safeBuffer(row.ciphertext),
            safeBuffer(row.iv),
            safeBuffer(row.tag),
            `${prefix}:${row.organization_id}:${row.provider}:${row.environment}:credential:v1`,
          ))
        } else if (descriptor.store === 'operations_carrier_accounts') {
          if (!['ups_rest', 'fedex_rest', 'usps_rest'].includes(row.provider)) {
            throw adoptionProofFailed()
          }
          const plaintext = decryptAesGcm(
            key,
            decodeBase64(row.ciphertext),
            decodeBase64(row.iv),
            decodeBase64(row.tag),
            `clawpilot:carrier:${row.organization_id}:${row.provider}:${row.environment}:account:${row.global_id}:v1`,
          )
          try {
            if (plaintext.byteLength < 2 || plaintext.byteLength > 128) {
              throw adoptionProofFailed()
            }
          } finally {
            plaintext.fill(0)
          }
        } else if (
          descriptor.store === 'operations_commerce_oauth_installations'
        ) {
          parseCredentialObject(decryptAesGcm(
            key,
            safeBuffer(row.ciphertext),
            safeBuffer(row.iv),
            safeBuffer(row.tag),
            `clawpilot:commerce:${row.organization_id}:faire:${row.browser_session_id}:${row.state_hash}:oauth-installation:v1`,
          ))
        } else if (
          descriptor.store === 'operations_commerce_webhook_receipts'
        ) {
          if (row.provider !== 'shopify') throw adoptionProofFailed()
          authenticateOpaquePayload(
            key,
            row,
            `clawpilot:commerce:${row.account_global_id}:shopify:${row.provider_event_id}:${row.topic}:webhook:v1`,
            2,
            524_288,
          )
        } else if (
          descriptor.store === 'operations_commerce_intake_read_intents'
        ) {
          if (
            !['shopify', 'faire'].includes(row.provider)
            || !row.provider_attempt_id
          ) {
            throw adoptionProofFailed()
          }
          authenticateOpaquePayload(
            key,
            row,
            `clawpilot:commerce:${row.organization_id}:${row.account_global_id}:${row.provider}:${row.intent_id}:${row.provider_attempt_id}:${row.request_hash}:intake-read-result:v1`,
            2,
            8_388_608,
          )
        } else if (
          descriptor.store === 'operations_commerce_intake_continuations'
        ) {
          if (!['shopify', 'faire'].includes(row.provider)) {
            throw adoptionProofFailed()
          }
          parseCredentialObject(decryptAesGcm(
            key,
            safeBuffer(row.ciphertext),
            safeBuffer(row.iv),
            safeBuffer(row.tag),
            `clawpilot:commerce:${row.organization_id}:${row.account_global_id}:${row.provider}:${row.session_id}:${row.batch_number}:${row.query_hash}:intake-continuation:v1`,
          ))
        } else if (
          descriptor.store === 'operations_commerce_order_candidates'
          || descriptor.store === 'operations_commerce_order_workbench'
          || descriptor.store
            === 'operations_order_shipment_address_working_copies'
        ) {
          if (!['party', 'ship_to'].includes(row.kind)) {
            throw adoptionProofFailed()
          }
          parseCredentialObject(decryptAesGcm(
            key,
            safeBuffer(row.ciphertext),
            safeBuffer(row.iv),
            safeBuffer(row.tag),
            `clawpilot:commerce:${row.organization_id}:${row.account_global_id}:${row.external_order_id}:${row.source_hash}:${row.kind}:candidate-snapshot:v1`,
          ))
        } else {
          throw adoptionProofFailed()
        }
        validated += 1
      }
    }
    return Object.freeze({ status: 'authenticated', validated })
  } finally {
    key.fill(0)
  }
}

function generatedInsertValues(generated, input) {
  return [
    generated.attestationVersion,
    generated.databaseIdentity,
    generated.keyId,
    generated.sentinelCiphertext,
    generated.sentinelIv,
    generated.sentinelTag,
    input.bootstrapMode,
    input.adoptionEvidenceSha256,
    input.actor,
  ]
}

function reviewedAdoptionInstallContext(generated, input) {
  const header = [
    'clawpilot:integration-credential-key-attestation:reviewed-adoption-install:v1',
    generated.attestationVersion,
    generated.databaseIdentity,
    generated.keyId,
    input.adoptionEvidenceSha256,
    input.actor,
    '',
  ].join('\n')
  return createHash('sha256')
    .update(header, 'utf8')
    .update(generated.sentinelCiphertext)
    .update(generated.sentinelIv)
    .update(generated.sentinelTag)
    .digest('hex')
}

async function insertAttestation(client, generated, input) {
  if (input.bootstrapMode === 'reviewed_adoption') {
    await client.query(
      'SELECT set_config($1, $2, true)',
      [
        INTEGRATION_CREDENTIAL_KEY_REVIEWED_ADOPTION_INSTALL_CONTEXT,
        reviewedAdoptionInstallContext(generated, input),
      ],
    )
  }
  const inserted = await client.query(
    `INSERT INTO operations_integration_credential_key_attestations (
       singleton_id, attestation_version, database_identity, key_id,
       sentinel_ciphertext, sentinel_iv, sentinel_tag, bootstrap_mode,
       adoption_evidence_sha256, created_by
     ) VALUES (
       1, $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9
     )
     RETURNING singleton_id, attestation_version,
               database_identity::text AS database_identity, key_id,
               sentinel_ciphertext, sentinel_iv, sentinel_tag,
               bootstrap_mode, adoption_evidence_sha256,
               created_by, created_at`,
    generatedInsertValues(generated, input),
  )
  return inserted.rows[0]
}

async function withAttestationTransaction(client, callback) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    try {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [INTEGRATION_CREDENTIAL_KEY_ATTESTATION_LOCK],
      )
      await lockIntegrationCredentialKeyBackedStores(client)
      const value = await callback()
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (
        !['40001', '40P01'].includes(String(error?.code || ''))
        || attempt === 2
      ) {
        throw error
      }
    }
  }
  throw operatorError(
    'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_CONCURRENCY_FAILED',
    'Integration credential key attestation could not serialize safely',
  )
}

function configFor(input, purpose = 'runtime') {
  return input.config || resolveIntegrationCredentialEncryptionKeyConfig({
    environment: input.environment,
    hosted: input.hosted,
    requireKeyId: true,
    allowHostedLegacyAgentFallback: Boolean(
      purpose === 'legacy_adoption'
      && input.allowHostedLegacyAgentFallback,
    ),
  })
}

export async function bootstrapEmptyIntegrationCredentialKeyAttestation(input) {
  const actor = normalizeActor(input.actor)
  const config = configFor(input)
  return withAttestationTransaction(input.client, async () => {
    const databaseIdentity = await requireExpectedDatabaseIdentity(
      input.client,
      input.expectedDatabaseIdentity,
    )
    const existing = await readAttestationRecord(input.client)
    if (existing) {
      return verifyIntegrationCredentialKeyAttestationRecord({
        record: existing,
        expectedDatabaseIdentity: databaseIdentity,
        keyId: config.keyId,
        keyMaterial: config.getKeyMaterial(),
      })
    }
    await ensureActorAuthorized(input.client, actor)
    const footprint = await readIntegrationCredentialKeyBackedFootprint(
      input.client,
    )
    if (footprint.total !== 0) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_LEGACY_FOOTPRINT_REQUIRES_REVIEW',
        'Key-backed records exist; use the reviewed adoption plan/apply flow',
      )
    }
    const generated = createIntegrationCredentialKeyAttestation({
      databaseIdentity,
      keyId: config.keyId,
      keyMaterial: config.getKeyMaterial(),
    })
    const record = await insertAttestation(input.client, generated, {
      actor,
      bootstrapMode: 'empty',
      adoptionEvidenceSha256: null,
    })
    return verifyIntegrationCredentialKeyAttestationRecord({
      record,
      expectedDatabaseIdentity: databaseIdentity,
      keyId: config.keyId,
      keyMaterial: config.getKeyMaterial(),
    })
  })
}

function adoptionPlanDigest(plan) {
  const copy = structuredClone(plan)
  delete copy.planDigest
  return sha256(canonicalJson(copy))
}

function validateAdoptionPlan(plan, now = Date.now()) {
  if (
    !plan
    || plan.format !== INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_FORMAT
    || plan.attestationVersion
      !== INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERSION
    || !SHA256_PATTERN.test(String(plan.planDigest || ''))
    || adoptionPlanDigest(plan) !== plan.planDigest
    || !SHA256_PATTERN.test(String(plan.footprint?.digest || ''))
    || !Array.isArray(plan.footprint?.stores)
    || !Number.isSafeInteger(plan.footprint?.total)
    || plan.footprint.total < 1
    || !Number.isSafeInteger(plan.footprint?.anchorCount)
    || plan.footprint.anchorCount < 1
    || plan.footprint.anchorCount !== plan.footprint.total
  ) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_INVALID',
      'Reviewed integration credential key adoption plan is invalid',
    )
  }
  normalizeIntegrationCredentialDatabaseIdentity(plan.databaseIdentity)
  normalizeActor(plan.actor)
  const createdAt = Date.parse(plan.createdAt)
  const expiresAt = Date.parse(plan.expiresAt)
  if (
    !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= createdAt
    || expiresAt - createdAt > INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_MAX_AGE_MS
    || now < createdAt - 60_000
    || now > expiresAt
  ) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_EXPIRED',
      'Reviewed integration credential key adoption plan is expired',
    )
  }
  return plan
}

export async function planIntegrationCredentialKeyAdoption(input) {
  const actor = normalizeActor(input.actor)
  const config = configFor(input, 'legacy_adoption')
  await input.client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await input.client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [INTEGRATION_CREDENTIAL_KEY_ATTESTATION_LOCK],
    )
    await lockIntegrationCredentialKeyBackedStores(input.client)
    const databaseIdentity = await requireExpectedDatabaseIdentity(
      input.client,
      input.expectedDatabaseIdentity,
    )
    if (await readAttestationRecord(input.client)) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_ALREADY_EXISTS',
        'Integration credential key attestation already exists',
      )
    }
    await ensureActorAuthorized(input.client, actor)
    const footprint = await readIntegrationCredentialKeyBackedFootprint(
      input.client,
    )
    if (footprint.total === 0) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_ADOPTION_NOT_REQUIRED',
        'Key-backed store is empty; use empty bootstrap',
      )
    }
    if (footprint.anchorCount === 0) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_UNAVAILABLE',
        'No credential anchor is available to authenticate the legacy key',
      )
    }
    const proof = await authenticateLegacyIntegrationCredentialAnchors(
      input.client,
      config.getKeyMaterial(),
    )
    if (proof.validated !== footprint.total) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
        'Legacy integration credential evidence could not be authenticated',
      )
    }
    const now = input.now instanceof Date ? input.now : new Date()
    const plan = {
      format: INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_FORMAT,
      attestationVersion: INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERSION,
      databaseIdentity,
      keyId: config.keyId,
      actor,
      footprint,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_MAX_AGE_MS,
      ).toISOString(),
    }
    plan.planDigest = adoptionPlanDigest(plan)
    await input.client.query('COMMIT')
    return Object.freeze(plan)
  } catch (error) {
    await input.client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

export async function applyIntegrationCredentialKeyAdoption(input) {
  const plan = validateAdoptionPlan(input.plan, input.now?.getTime())
  const reviewedPlanDigest = String(input.reviewedPlanDigest || '')
    .trim()
    .toLowerCase()
  if (
    !SHA256_PATTERN.test(reviewedPlanDigest)
    || reviewedPlanDigest !== plan.planDigest
  ) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ADOPTION_REVIEW_REQUIRED',
      'Exact reviewed adoption plan digest confirmation is required',
    )
  }
  const actor = normalizeActor(input.actor)
  const config = configFor(input, 'legacy_adoption')
  if (actor !== plan.actor || config.keyId !== plan.keyId) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_MISMATCH',
      'Reviewed integration credential key adoption plan no longer matches configuration',
    )
  }
  return withAttestationTransaction(input.client, async () => {
    const databaseIdentity = await requireExpectedDatabaseIdentity(
      input.client,
      input.expectedDatabaseIdentity,
    )
    if (databaseIdentity !== plan.databaseIdentity) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_MISMATCH',
        'Reviewed integration credential key adoption plan no longer matches configuration',
      )
    }
    const existing = await readAttestationRecord(input.client)
    if (existing) {
      if (existing.adoption_evidence_sha256 !== plan.planDigest) {
        throw operatorError(
          'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_ALREADY_EXISTS',
          'A different integration credential key attestation already exists',
        )
      }
      return verifyIntegrationCredentialKeyAttestationRecord({
        record: existing,
        expectedDatabaseIdentity: databaseIdentity,
        keyId: config.keyId,
        keyMaterial: config.getKeyMaterial(),
      })
    }
    await ensureActorAuthorized(input.client, actor)
    const footprint = await readIntegrationCredentialKeyBackedFootprint(
      input.client,
    )
    if (canonicalJson(footprint) !== canonicalJson(plan.footprint)) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_ADOPTION_FOOTPRINT_CHANGED',
        'Key-backed footprint changed after adoption plan review',
      )
    }
    const proof = await authenticateLegacyIntegrationCredentialAnchors(
      input.client,
      config.getKeyMaterial(),
    )
    if (proof.validated !== footprint.total) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PROOF_FAILED',
        'Legacy integration credential evidence could not be authenticated',
      )
    }
    const generated = createIntegrationCredentialKeyAttestation({
      databaseIdentity,
      keyId: config.keyId,
      keyMaterial: config.getKeyMaterial(),
    })
    const record = await insertAttestation(input.client, generated, {
      actor,
      bootstrapMode: 'reviewed_adoption',
      adoptionEvidenceSha256: plan.planDigest,
    })
    return verifyIntegrationCredentialKeyAttestationRecord({
      record,
      expectedDatabaseIdentity: databaseIdentity,
      keyId: config.keyId,
      keyMaterial: config.getKeyMaterial(),
    })
  })
}

function parseArguments(argv) {
  const command = argv[0]
  const options = { command }
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw operatorError(
        'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_ARGUMENT_INVALID',
        'Attestation command arguments are invalid',
      )
    }
    const name = flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => (
      letter.toUpperCase()
    ))
    options[name] = value
    index += 1
  }
  return options
}

function writePrivateJson(file, value) {
  const destination = path.resolve(file)
  const handle = fs.openSync(destination, 'wx', 0o600)
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fchmodSync(handle, 0o600)
  } finally {
    fs.closeSync(handle)
  }
  return destination
}

function readPrivateJson(file) {
  const source = path.resolve(file)
  const stat = fs.statSync(source)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ADOPTION_PLAN_PERMISSIONS_INVALID',
      'Adoption plan must be a private regular file with mode 0600',
    )
  }
  return JSON.parse(fs.readFileSync(source, 'utf8'))
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv)
  if (!['verify', 'bootstrap-empty', 'adopt-plan', 'adopt-apply'].includes(options.command)) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_COMMAND_INVALID',
      'Use verify, bootstrap-empty, adopt-plan, or adopt-apply',
    )
  }
  const databaseUrl = String(environment.DATABASE_URL || '').trim()
  if (!databaseUrl) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_DATABASE_URL_REQUIRED',
      'DATABASE_URL is required',
    )
  }
  const expectedDatabaseIdentity = options.expectedDatabaseIdentity
  const legacyAgentFallbackRequested =
    options.allowHostedLegacyAgentKey === 'true'
  if (
    options.allowHostedLegacyAgentKey !== undefined
    && options.allowHostedLegacyAgentKey !== 'true'
  ) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_ARGUMENT_INVALID',
      '--allow-hosted-legacy-agent-key only accepts true',
    )
  }
  if (
    legacyAgentFallbackRequested
    && !['adopt-plan', 'adopt-apply'].includes(options.command)
  ) {
    throw operatorError(
      'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_ARGUMENT_INVALID',
      'Hosted legacy agent-key fallback is allowed only for reviewed adoption',
    )
  }
  const config = resolveIntegrationCredentialEncryptionKeyConfig({
    environment,
    // Operator commands may run from a laptop against a hosted database.
    // Always enforce the hosted key contract instead of inferring trust from
    // the machine that launched the command.
    hosted: true,
    requireKeyId: true,
    allowHostedLegacyAgentFallback: legacyAgentFallbackRequested,
  })
  const sslMode = String(
    environment.PGSSLMODE || environment.DATABASE_SSL || '',
  ).toLowerCase()
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: ['require', 'true'].includes(sslMode)
      ? { rejectUnauthorized: false }
      : undefined,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  })
  const client = await pool.connect()
  try {
    let result
    if (options.command === 'verify') {
      const databaseIdentity = await requireExpectedDatabaseIdentity(
        client,
        expectedDatabaseIdentity,
      )
      result = await verifyIntegrationCredentialKeyAttestation({
        client,
        secret: config.getKeyMaterial(),
        keyId: config.keyId,
        expectedDatabaseIdentity: databaseIdentity,
      })
    } else if (options.command === 'bootstrap-empty') {
      result = await bootstrapEmptyIntegrationCredentialKeyAttestation({
        client,
        config,
        actor: options.actor,
        expectedDatabaseIdentity,
      })
    } else if (options.command === 'adopt-plan') {
      const plan = await planIntegrationCredentialKeyAdoption({
        client,
        config,
        actor: options.actor,
        expectedDatabaseIdentity,
      })
      const destination = writePrivateJson(options.out, plan)
      result = {
        status: 'planned',
        keyId: plan.keyId,
        databaseIdentity: plan.databaseIdentity,
        footprint: plan.footprint,
        planDigest: plan.planDigest,
        planPath: destination,
        expiresAt: plan.expiresAt,
      }
    } else {
      const plan = readPrivateJson(options.plan)
      result = await applyIntegrationCredentialKeyAdoption({
        client,
        config,
        actor: options.actor,
        expectedDatabaseIdentity,
        plan,
        reviewedPlanDigest: options.reviewedPlanDigest,
      })
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result
  } finally {
    client.release()
    await pool.end()
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = String(
      error?.code || 'INTEGRATION_CREDENTIAL_KEY_ATTESTATION_FAILED',
    )
    const message = error instanceof IntegrationCredentialKeyAttestationOperatorError
      ? error.message
      : 'Integration credential key attestation command failed'
    process.stderr.write(`${code}: ${message}\n`)
    process.exitCode = 1
  })
}
