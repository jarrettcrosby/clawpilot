import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

import {
  deriveIntegrationCredentialEncryptionKey,
  normalizeIntegrationCredentialDatabaseIdentity,
  normalizeIntegrationCredentialKeyId,
  verifyIntegrationCredentialKeyAttestationRecord,
} from './integrationCredentialKeyAttestation.mjs'

export const INTEGRATION_CREDENTIAL_RUNTIME_MODE_ENV =
  'INTEGRATION_CREDENTIAL_ATTESTATION_MODE'
export const INTEGRATION_CREDENTIAL_RUNTIME_PROOF_ENV =
  'INTEGRATION_CREDENTIAL_RUNTIME_PROOF'
export const INTEGRATION_CREDENTIAL_RUNTIME_MODE_STRICT = 'strict'
export const INTEGRATION_CREDENTIAL_RUNTIME_MODE_ADOPTION = 'adoption'
export const INTEGRATION_CREDENTIAL_RUNTIME_PROOF_FORMAT =
  'clawpilot-integration-credential-runtime-proof-v1'
export const INTEGRATION_CREDENTIAL_RUNTIME_PROOF_TTL_MS = 15 * 60 * 1000
export const INTEGRATION_CREDENTIAL_RUNTIME_REFRESH_INTERVAL_MS = 60 * 1000
export const INTEGRATION_CREDENTIAL_RUNTIME_ADOPTION_MAX_AGE_MS =
  2 * 60 * 60 * 1000
export const INTEGRATION_CREDENTIAL_RUNTIME_ADOPTION_DEADLINE_ENV =
  'INTEGRATION_CREDENTIAL_ATTESTATION_ADOPTION_DEADLINE'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const PROOF_PATTERN = /^[A-Za-z0-9_-]{40,4096}\.[A-Za-z0-9_-]{43}$/u
const PROOF_CLOCK_SKEW_MS = 30 * 1000
const ATTESTATION_MIGRATION =
  '0356_operations_integration_credential_key_attestation.sql'
const ATTESTATION_MIGRATION_SHA256 =
  '7d66bab80f112d4c07466c8530921c514d67f4db8231ea97019b71005b74506f'
const PRODUCT_IMAGE_RUNTIME_PARKING_MIGRATION =
  '0357_operations_commerce_product_image_runtime_parking.sql'
const PRODUCT_IMAGE_RUNTIME_PARKING_MIGRATION_SHA256 =
  'e8636998cfa8e8e24717ba7ffda11f4e2e0031fc83a439914a18f6d568c836a2'
const PRODUCT_IMAGE_RUNTIME_PARKING_PROSRC_SHA256 =
  '57f2f359ae6b82e9dae121a295a3e85e783df45fbd78287d44af71a30d4235e0'
const revokedRuntimeProofEnvironments = new WeakSet()
const runtimeRefreshQueues = new WeakMap()
let primitiveEnvironmentRefreshQueue = Promise.resolve()

export class IntegrationCredentialRuntimeGateError extends Error {
  constructor(code) {
    super(code)
    this.name = 'IntegrationCredentialRuntimeGateError'
    this.code = code
  }
}

export function isIntegrationCredentialRuntimeGateError(error) {
  return error instanceof IntegrationCredentialRuntimeGateError
}

function fail(code) {
  throw new IntegrationCredentialRuntimeGateError(code)
}

function value(environment, name) {
  return String(environment?.[name] || '')
}

function vercelRuntimeDetected(environment) {
  return Boolean(
    value(environment, 'VERCEL')
    || value(environment, 'VERCEL_ENV')
    || value(environment, 'VERCEL_DEPLOYMENT_ID')
    || value(environment, 'VERCEL_URL'),
  )
}

function actualRuntimeEnvironmentCannotBeOverridden(environment) {
  return integrationCredentialRuntimeEnforcementRequired(environment)
    || vercelRuntimeDetected(environment)
}

function authoritativeRuntimeEnvironment(candidate) {
  // Test fixtures may supply an isolated environment while the actual process
  // is local. Once the real process is hosted, however, no exported caller may
  // replace that environment with a permissive local object.
  return actualRuntimeEnvironmentCannotBeOverridden(process.env)
    ? process.env
    : candidate || process.env
}

function deploymentIdentity(environment) {
  const identity = value(environment, 'RAILWAY_DEPLOYMENT_ID')
    || value(environment, 'VERCEL_DEPLOYMENT_ID')
    || value(environment, 'VERCEL_URL')
    || 'hosted-unscoped'
  if (
    identity.length < 1
    || identity.length > 512
    || /[\u0000-\u001f\u007f]/u.test(identity)
  ) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_DEPLOYMENT_ID_INVALID')
  }
  return identity
}

function databaseEndpointFingerprint(environment) {
  const databaseUrl = value(environment, 'DATABASE_URL')
  if (databaseUrl.length < 16) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_DATABASE_URL_REQUIRED')
  }
  return createHash('sha256').update(databaseUrl, 'utf8').digest('hex')
}

export function integrationCredentialRuntimeEnforcementRequired(
  environment = process.env,
) {
  return Boolean(
    value(environment, 'RAILWAY_ENVIRONMENT_NAME')
    || value(environment, 'RAILWAY_ENVIRONMENT_ID')
    || value(environment, 'RAILWAY_PROJECT_ID')
    || value(environment, 'RAILWAY_ENVIRONMENT')
  ) || Boolean(
    value(environment, 'CLAWPILOT_STORAGE') === 'postgres'
    && value(environment, 'DATABASE_URL'),
  )
}

function runtimeMode(environment, hosted, now) {
  if (!hosted) return { mode: 'local', adoptionDeadline: null }
  const configured = value(
    environment,
    INTEGRATION_CREDENTIAL_RUNTIME_MODE_ENV,
  ).trim() || INTEGRATION_CREDENTIAL_RUNTIME_MODE_STRICT
  if (
    configured !== INTEGRATION_CREDENTIAL_RUNTIME_MODE_STRICT
    && configured !== INTEGRATION_CREDENTIAL_RUNTIME_MODE_ADOPTION
  ) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_MODE_INVALID')
  }
  if (configured === INTEGRATION_CREDENTIAL_RUNTIME_MODE_STRICT) {
    return { mode: configured, adoptionDeadline: null }
  }
  const rawDeadline = value(
    environment,
    INTEGRATION_CREDENTIAL_RUNTIME_ADOPTION_DEADLINE_ENV,
  ).trim()
  const deadline = Date.parse(rawDeadline)
  if (
    !rawDeadline
    || !Number.isFinite(deadline)
    || deadline <= now
    || deadline - now > INTEGRATION_CREDENTIAL_RUNTIME_ADOPTION_MAX_AGE_MS
  ) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_ADOPTION_DEADLINE_INVALID')
  }
  return {
    mode: configured,
    adoptionDeadline: new Date(deadline).toISOString(),
  }
}

/**
 * Resolves the one integration-credential key contract used by every hosted
 * crypto consumer. Hosted runtimes never inherit the agent credential key.
 * Local development retains the historical fallbacks so isolated fixtures do
 * not need production credential material.
 */
export function resolveIntegrationCredentialRuntimeConfiguration(
  options = {},
) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  // Runtime classification is derived only from the environment. An exported
  // caller must never be able to downgrade a Railway or authenticated Postgres
  // process into the permissive local contract with an options override.
  const hosted = integrationCredentialRuntimeEnforcementRequired(environment)
  const now = options.now === undefined ? Date.now() : Number(options.now)
  if (!Number.isFinite(now)) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_TIME_INVALID')
  }
  const { mode, adoptionDeadline } = runtimeMode(environment, hosted, now)
  const integrationKey = value(
    environment,
    'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY',
  )
  const keyMaterial = hosted
    ? integrationKey
    : integrationKey
      || value(environment, 'AGENT_CREDENTIAL_ENCRYPTION_KEY')
      || value(environment, 'APP_SESSION_SECRET')
  if (keyMaterial.length < 32) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_KEY_REQUIRED')
  }
  const configuredKeyId = value(
    environment,
    'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID',
  ).trim()
  let keyId
  try {
    keyId = normalizeIntegrationCredentialKeyId(
      configuredKeyId || (!hosted ? 'local-development-v1' : ''),
    )
  } catch {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_KEY_ID_REQUIRED')
  }
  const summary = { hosted, mode, keyId, adoptionDeadline }
  Object.defineProperties(summary, {
    getKeyMaterial: {
      enumerable: false,
      value() {
        return keyMaterial
      },
    },
    getDerivedKey: {
      enumerable: false,
      value() {
        return deriveIntegrationCredentialEncryptionKey(keyMaterial)
      },
    },
  })
  return Object.freeze(summary)
}

function canonicalProofPayload(
  input,
  configuration,
  environment,
  options = {},
) {
  const databaseIdentity = normalizeIntegrationCredentialDatabaseIdentity(
    input?.databaseIdentity,
  )
  const recordDigest = input?.recordDigest == null
    ? null
    : String(input.recordDigest)
  if (recordDigest != null && !SHA256_PATTERN.test(recordDigest)) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID')
  }
  const status = String(input?.status || '')
  const validStatus = configuration.mode === INTEGRATION_CREDENTIAL_RUNTIME_MODE_STRICT
    ? status === 'verified'
    : status === 'adoption_required' || status === 'adoption_verified'
  if (!validStatus || (status !== 'adoption_required' && !recordDigest)) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID')
  }
  if (status === 'adoption_required' && recordDigest !== null) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID')
  }
  const now = options.now === undefined ? Date.now() : Number(options.now)
  const issuedAt = options.creating === true
    ? now
    : Number(input?.issuedAt)
  const expiresAt = options.creating === true
    ? issuedAt + INTEGRATION_CREDENTIAL_RUNTIME_PROOF_TTL_MS
    : Number(input?.expiresAt)
  if (
    !Number.isSafeInteger(now)
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > INTEGRATION_CREDENTIAL_RUNTIME_PROOF_TTL_MS
    || now < issuedAt - PROOF_CLOCK_SKEW_MS
    || (options.allowExpired !== true && now >= expiresAt)
  ) {
    fail(
      Number.isSafeInteger(expiresAt) && now >= expiresAt
        ? 'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_EXPIRED'
        : 'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID',
    )
  }
  return Object.freeze({
    format: INTEGRATION_CREDENTIAL_RUNTIME_PROOF_FORMAT,
    mode: configuration.mode,
    status,
    keyId: configuration.keyId,
    databaseIdentity,
    databaseEndpointSha256: databaseEndpointFingerprint(environment),
    deploymentIdentity: deploymentIdentity(environment),
    adoptionDeadline: configuration.adoptionDeadline,
    recordDigest,
    issuedAt,
    expiresAt,
  })
}

function proofSigningKey(configuration) {
  const derived = configuration.getDerivedKey()
  try {
    return createHmac('sha256', derived)
      .update('clawpilot:integration-credential-runtime-proof:v1', 'utf8')
      .digest()
  } finally {
    derived.fill(0)
  }
}

export function createIntegrationCredentialRuntimeProof(input, options = {}) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const configuration = resolveIntegrationCredentialRuntimeConfiguration({
    environment,
    now: options.now,
  })
  if (!configuration.hosted) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_HOSTED_ONLY')
  }
  const payload = canonicalProofPayload(input, configuration, environment, {
    creating: true,
    now: options.now,
  })
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signingKey = proofSigningKey(configuration)
  try {
    const signature = createHmac('sha256', signingKey)
      .update(encoded, 'ascii')
      .digest('base64url')
    return `${encoded}.${signature}`
  } finally {
    signingKey.fill(0)
  }
}

export function verifyIntegrationCredentialRuntimeProof(options = {}) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const configuration = resolveIntegrationCredentialRuntimeConfiguration({
    environment,
    now: options.now,
  })
  if (!configuration.hosted) {
    const providerIoReady = !vercelRuntimeDetected(environment)
    return Object.freeze({
      status: providerIoReady ? 'local' : 'preview',
      mode: providerIoReady ? 'local' : 'preview',
      keyId: configuration.keyId,
      providerIoReady,
    })
  }
  if (
    environment
    && typeof environment === 'object'
    && revokedRuntimeProofEnvironments.has(environment)
  ) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE')
  }
  const proof = String(
    options.proof === undefined
      ? environment?.[INTEGRATION_CREDENTIAL_RUNTIME_PROOF_ENV] || ''
      : options.proof,
  )
  if (!PROOF_PATTERN.test(proof)) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_REQUIRED')
  }
  const [encoded, suppliedSignature] = proof.split('.')
  const signingKey = proofSigningKey(configuration)
  let expectedSignature
  try {
    expectedSignature = createHmac('sha256', signingKey)
      .update(encoded, 'ascii')
      .digest()
  } finally {
    signingKey.fill(0)
  }
  let supplied
  try {
    supplied = Buffer.from(suppliedSignature, 'base64url')
  } catch {
    expectedSignature.fill(0)
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID')
  }
  const signatureValid = supplied.byteLength === expectedSignature.byteLength
    && timingSafeEqual(supplied, expectedSignature)
  supplied.fill(0)
  expectedSignature.fill(0)
  if (!signatureValid) fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID')

  let decoded
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID')
  }
  const normalized = canonicalProofPayload(decoded, configuration, environment, {
    allowExpired: options.allowExpired === true,
    now: options.now,
  })
  if (JSON.stringify(decoded) !== JSON.stringify(normalized)) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID')
  }
  return Object.freeze({
    ...normalized,
    providerIoReady:
      normalized.mode === INTEGRATION_CREDENTIAL_RUNTIME_MODE_STRICT
      && normalized.status === 'verified',
  })
}

/**
 * Synchronous provider boundary. Hosted callers must invoke this before any
 * provider request or mutation of key-backed integration state, including
 * mutations that happen before a credential is encrypted or decrypted. The
 * short-lived proof was issued only after a direct durable-sentinel read.
 */
export function assertIntegrationCredentialProviderIoReady(options = {}) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const proof = verifyIntegrationCredentialRuntimeProof({
    environment,
    proof: options.proof,
    now: options.now,
  })
  if (!proof.providerIoReady) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROVIDER_IO_DISABLED')
  }
  return Object.freeze({
    mode: proof.mode,
    status: proof.status,
    providerIoReady: true,
  })
}

export async function readIntegrationCredentialRuntimeAttestation(
  options = {},
) {
  const client = options.client
  if (!client || typeof client.query !== 'function') {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_DATABASE_REQUIRED')
  }
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const configuration = resolveIntegrationCredentialRuntimeConfiguration({
    environment,
    now: options.now,
  })
  let identityResult
  try {
    identityResult = await client.query(
      `SELECT to_regclass(
                'public.operations_integration_credential_key_attestations'
              )::text AS attestation_table,
              EXISTS (
                SELECT 1
                FROM public.schema_migrations
                WHERE filename = $1
                  AND checksum = $2
              ) AS attestation_migration_applied,
              EXISTS (
                SELECT 1
                FROM public.schema_migrations
                WHERE filename = $3
                  AND checksum = $4
              ) AS product_image_runtime_parking_migration_applied,
              to_regclass(
                'public.operations_commerce_product_image_import_jobs'
              )::text AS product_image_import_jobs_table,
              (
                SELECT NOT procedure_row.prosecdef
                   AND procedure_row.proconfig @>
                         ARRAY['search_path=pg_catalog, public']::text[]
                   AND pg_catalog.encode(
                         public.digest(
                           pg_catalog.convert_to(
                             pg_catalog.btrim(
                               pg_catalog.regexp_replace(
                                 pg_catalog.regexp_replace(
                                   procedure_row.prosrc,
                                   E'(^|[\\n\\r])[[:blank:]]*--[^\\n\\r]*',
                                   ' ',
                                   'g'
                                 ),
                                 '[[:space:]]+',
                                 ' ',
                                 'g'
                               )
                             ),
                             'UTF8'
                           ),
                           'sha256'
                         ),
                         'hex'
                       ) = $5
                FROM pg_catalog.pg_proc procedure_row
                WHERE procedure_row.oid =
                  'public.guard_operations_commerce_product_image_import_job()'::regprocedure
              ) AS product_image_runtime_parking_function_valid,
              EXISTS (
                SELECT 1
                FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid =
                        'public.operations_commerce_product_image_import_jobs'::regclass
                  AND trigger_row.tgname =
                        'guard_operations_commerce_product_image_import_job_write'
                  AND trigger_row.tgfoid =
                        'public.guard_operations_commerce_product_image_import_job()'::regprocedure
                  AND trigger_row.tgenabled = 'O'
                  AND trigger_row.tgtype = 31
                  AND NOT trigger_row.tgisinternal
              ) AS product_image_runtime_parking_trigger_valid,
              (SELECT CASE
                 WHEN value->>'id'
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                   THEN lower(value->>'id')
                 ELSE NULL
               END
               FROM public.app_settings
               WHERE key = 'deployment.database.identity')
                 AS database_identity,
              (
                SELECT array_agg(
                         attribute_row.attname || ':'
                         || pg_catalog.format_type(
                              attribute_row.atttypid,
                              attribute_row.atttypmod
                            ) || ':' || attribute_row.attnotnull::text
                         ORDER BY attribute_row.attnum
                       ) = ARRAY[
                         'singleton_id:smallint:true',
                         'attestation_version:text:true',
                         'database_identity:uuid:true',
                         'key_id:text:true',
                         'sentinel_ciphertext:bytea:true',
                         'sentinel_iv:bytea:true',
                         'sentinel_tag:bytea:true',
                         'bootstrap_mode:text:true',
                         'adoption_evidence_sha256:text:false',
                         'created_by:text:true',
                         'created_at:timestamp with time zone:true'
                       ]
                FROM pg_catalog.pg_attribute attribute_row
                WHERE attribute_row.attrelid =
                        'public.operations_integration_credential_key_attestations'::regclass
                  AND attribute_row.attnum > 0
                  AND NOT attribute_row.attisdropped
              ) AS attestation_columns_valid,
              (
                SELECT count(*) = 10
                   AND count(*) FILTER (WHERE constraint_row.contype = 'p') = 1
                   AND count(*) FILTER (WHERE constraint_row.contype = 'f') = 1
                   AND count(*) FILTER (WHERE constraint_row.contype = 'c') = 8
                FROM pg_catalog.pg_constraint constraint_row
                WHERE constraint_row.conrelid =
                        'public.operations_integration_credential_key_attestations'::regclass
              ) AS attestation_constraints_valid,
              (
                SELECT array_agg(
                         trigger_row.tgname || ':'
                         || trigger_row.tgfoid::regprocedure::text || ':'
                         || trigger_row.tgenabled::text
                         ORDER BY trigger_row.tgname
                       ) = ARRAY[
                         'reject_integration_credential_key_attestation_truncate:reject_integration_credential_key_attestation_mutation():O',
                         'reject_integration_credential_key_attestation_update_delete:reject_integration_credential_key_attestation_mutation():O',
                         'validate_integration_credential_key_attestation_insert:validate_integration_credential_key_attestation_insert():O'
                       ]
                FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid =
                        'public.operations_integration_credential_key_attestations'::regclass
                  AND NOT trigger_row.tgisinternal
              ) AS attestation_triggers_valid,
              (
                SELECT count(*) = 2
                   AND bool_and(NOT procedure_row.prosecdef)
                   AND bool_and(
                         procedure_row.proconfig @>
                           ARRAY['search_path=public, pg_catalog']::text[]
                       )
                   AND bool_and(
                     CASE procedure_row.proname
                       WHEN 'validate_integration_credential_key_attestation_insert'
                         THEN position('LOCK TABLE' IN procedure_row.prosrc) > 0
                          AND position(
                                'reviewed_adoption_install_context'
                                IN procedure_row.prosrc
                              ) > 0
                       WHEN 'reject_integration_credential_key_attestation_mutation'
                         THEN position('immutable' IN procedure_row.prosrc) > 0
                       ELSE false
                     END
                   )
                   AND bool_and(NOT EXISTS (
                         SELECT 1
                         FROM pg_catalog.aclexplode(
                           coalesce(
                             procedure_row.proacl,
                             pg_catalog.acldefault('f', procedure_row.proowner)
                           )
                         ) privilege_row
                         WHERE privilege_row.grantee = 0
                           AND privilege_row.privilege_type = 'EXECUTE'
                       ))
                FROM pg_catalog.pg_proc procedure_row
                WHERE procedure_row.oid IN (
                  'public.validate_integration_credential_key_attestation_insert()'::regprocedure,
                  'public.reject_integration_credential_key_attestation_mutation()'::regprocedure
                )
              ) AS attestation_functions_valid,
              (
                SELECT pg_catalog.pg_get_userbyid(class_row.relowner) = current_user
                   AND NOT EXISTS (
                     SELECT 1
                     FROM pg_catalog.aclexplode(
                       coalesce(
                         class_row.relacl,
                         pg_catalog.acldefault('r', class_row.relowner)
                       )
                     ) privilege_row
                     WHERE privilege_row.grantee = 0
                   )
                FROM pg_catalog.pg_class class_row
                WHERE class_row.oid =
                        'public.operations_integration_credential_key_attestations'::regclass
                  AND class_row.relkind = 'r'
              ) AS attestation_privileges_valid`,
      [
        ATTESTATION_MIGRATION,
        ATTESTATION_MIGRATION_SHA256,
        PRODUCT_IMAGE_RUNTIME_PARKING_MIGRATION,
        PRODUCT_IMAGE_RUNTIME_PARKING_MIGRATION_SHA256,
        PRODUCT_IMAGE_RUNTIME_PARKING_PROSRC_SHA256,
      ],
    )
  } catch {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED')
  }
  const identity = identityResult?.rows?.[0] || {}
  if (
    !identity.attestation_table
    || !identity.attestation_migration_applied
    || !identity.product_image_import_jobs_table
    || !identity.product_image_runtime_parking_migration_applied
    || identity.product_image_runtime_parking_function_valid !== true
    || identity.product_image_runtime_parking_trigger_valid !== true
    || identity.attestation_columns_valid !== true
    || identity.attestation_constraints_valid !== true
    || identity.attestation_triggers_valid !== true
    || identity.attestation_functions_valid !== true
    || identity.attestation_privileges_valid !== true
  ) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED')
  }
  let databaseIdentity
  try {
    databaseIdentity = normalizeIntegrationCredentialDatabaseIdentity(
      identity.database_identity,
    )
  } catch {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_DATABASE_IDENTITY_INVALID')
  }
  let sentinelResult
  try {
    sentinelResult = await client.query(
      `SELECT singleton_id, attestation_version,
              database_identity::text AS database_identity, key_id,
              sentinel_ciphertext, sentinel_iv, sentinel_tag,
              bootstrap_mode, adoption_evidence_sha256,
              created_by, created_at
       FROM public.operations_integration_credential_key_attestations
       WHERE singleton_id = 1`,
    )
  } catch {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_ATTESTATION_INVALID')
  }
  const rows = sentinelResult?.rows || []
  if (rows.length !== 1) {
    if (
      rows.length === 0
      && configuration.mode === INTEGRATION_CREDENTIAL_RUNTIME_MODE_ADOPTION
    ) {
      return Object.freeze({
        mode: configuration.mode,
        status: 'adoption_required',
        keyId: configuration.keyId,
        databaseIdentity,
        recordDigest: null,
        deploymentReady: true,
        providerIoReady: false,
      })
    }
    fail('INTEGRATION_CREDENTIAL_RUNTIME_ATTESTATION_REQUIRED')
  }
  let verified
  try {
    verified = verifyIntegrationCredentialKeyAttestationRecord({
      record: rows[0],
      expectedDatabaseIdentity: databaseIdentity,
      keyId: configuration.keyId,
      keyMaterial: configuration.getKeyMaterial(),
    })
  } catch {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_ATTESTATION_INVALID')
  }
  if (configuration.mode === INTEGRATION_CREDENTIAL_RUNTIME_MODE_ADOPTION) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_ADOPTION_COMPLETE_STRICT_REQUIRED')
  }
  const status = 'verified'
  return Object.freeze({
    mode: configuration.mode,
    status,
    keyId: configuration.keyId,
    databaseIdentity,
    recordDigest: verified.recordDigest,
    deploymentReady: true,
    providerIoReady:
      configuration.mode === INTEGRATION_CREDENTIAL_RUNTIME_MODE_STRICT,
  })
}

export async function verifyIntegrationCredentialRuntimeReadiness(
  options = {},
) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const attestation = await readIntegrationCredentialRuntimeAttestation({
    client: options.client,
    environment,
    now: options.now,
  })
  const proof = verifyIntegrationCredentialRuntimeProof({
    environment,
    proof: options.proof,
    now: options.now,
  })
  if (
    proof.status !== attestation.status
    || proof.databaseIdentity !== attestation.databaseIdentity
    || proof.recordDigest !== attestation.recordDigest
  ) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE')
  }
  return Object.freeze({
    ...attestation,
    proofVerified: true,
  })
}

function runtimeProofMatchesAttestation(proof, attestation) {
  return proof.status === attestation.status
    && proof.databaseIdentity === attestation.databaseIdentity
    && proof.recordDigest === attestation.recordDigest
}

/**
 * Reads and authenticates the durable sentinel before issuing a short-lived,
 * process-local proof. Railway invokes this before starting Next.js. Next.js
 * instrumentation invokes it for every Node cold start that carries the
 * authenticated Postgres runtime contract.
 */
async function refreshIntegrationCredentialRuntimeReadinessUnchecked(
  options = {},
) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const configuration = resolveIntegrationCredentialRuntimeConfiguration({
    environment,
    now: options.now,
  })
  if (!configuration.hosted) {
    const proof = verifyIntegrationCredentialRuntimeProof({
      environment,
      now: options.now,
    })
    return Object.freeze({
      ...proof,
      deploymentReady: true,
      proofVerified: true,
      proofRefreshed: false,
    })
  }
  const attestation = await readIntegrationCredentialRuntimeAttestation({
    client: options.client,
    environment,
    now: options.now,
  })
  const currentProof = value(
    environment,
    INTEGRATION_CREDENTIAL_RUNTIME_PROOF_ENV,
  )
  let proofVerified = false
  if (currentProof) {
    const decoded = verifyIntegrationCredentialRuntimeProof({
      environment,
      proof: currentProof,
      allowExpired: true,
      now: options.now,
    })
    if (!runtimeProofMatchesAttestation(decoded, attestation)) {
      fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE')
    }
    proofVerified = true
  } else if (options.allowMissingProof !== true) {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_REQUIRED')
  }
  const proof = createIntegrationCredentialRuntimeProof(attestation, {
    environment,
    now: options.now,
  })
  try {
    environment[INTEGRATION_CREDENTIAL_RUNTIME_PROOF_ENV] = proof
  } catch {
    fail('INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INSTALL_FAILED')
  }
  if (environment && typeof environment === 'object') {
    revokedRuntimeProofEnvironments.delete(environment)
  }
  return Object.freeze({
    ...attestation,
    proofVerified,
    proofRefreshed: true,
  })
}

export async function refreshIntegrationCredentialRuntimeReadiness(
  options = {},
) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const operation = async () => {
    try {
      return await refreshIntegrationCredentialRuntimeReadinessUnchecked({
        ...options,
        environment,
      })
    } catch (error) {
      if (environment && typeof environment === 'object') {
        revokedRuntimeProofEnvironments.add(environment)
      }
      try {
        delete environment[INTEGRATION_CREDENTIAL_RUNTIME_PROOF_ENV]
      } catch {
        // The WeakSet revocation above remains authoritative when a caller
        // supplies an immutable environment object.
      }
      throw error
    }
  }

  // Serialize direct sentinel reads and proof installation per environment.
  // Without this queue, an older slow success could install a proof after a
  // newer refresh had already failed and revoked the process.
  if (environment && typeof environment === 'object') {
    const previous = runtimeRefreshQueues.get(environment) || Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    runtimeRefreshQueues.set(environment, current.catch(() => undefined))
    return current
  }
  const current = primitiveEnvironmentRefreshQueue
    .catch(() => undefined)
    .then(operation)
  primitiveEnvironmentRefreshQueue = current.catch(() => undefined)
  return current
}

const runtimeRefreshState = Symbol.for(
  'clawpilot.integrationCredentialRuntimeRefreshState',
)

/**
 * Keeps long-lived Railway processes bounded by the same durable proof window.
 * Serverless runtimes may freeze timers; their proof therefore fails closed at
 * expiry and a new cold start must attest again.
 */
export function scheduleIntegrationCredentialRuntimeRefresh(options = {}) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const configuration = resolveIntegrationCredentialRuntimeConfiguration({
    environment,
  })
  if (!configuration.hosted) return null
  const root = globalThis
  if (root[runtimeRefreshState]) return root[runtimeRefreshState]
  const interval = setInterval(async () => {
    try {
      await refreshIntegrationCredentialRuntimeReadiness({
        ...options,
        environment,
        allowMissingProof: true,
      })
    } catch (error) {
      const code = error instanceof IntegrationCredentialRuntimeGateError
        ? error.code
        : 'INTEGRATION_CREDENTIAL_RUNTIME_VERIFICATION_FAILED'
      delete environment[INTEGRATION_CREDENTIAL_RUNTIME_PROOF_ENV]
      console.error('[integration-credential-runtime] refresh failed', { code })
    }
  }, options.intervalMs || INTEGRATION_CREDENTIAL_RUNTIME_REFRESH_INTERVAL_MS)
  interval.unref?.()
  root[runtimeRefreshState] = interval
  return interval
}

/**
 * Synchronous crypto boundary. The Railway bootstrap creates the signed proof
 * only after reading and decrypting the immutable database sentinel. Thus
 * every credential read/write and keyed provider fingerprint revalidates that
 * startup proof before receiving key bytes.
 */
export function integrationCredentialRuntimeEncryptionKey(options = {}) {
  const environment = authoritativeRuntimeEnvironment(options.environment)
  const configuration = resolveIntegrationCredentialRuntimeConfiguration({ environment })
  assertIntegrationCredentialProviderIoReady({
    environment,
  })
  return configuration.getDerivedKey()
}
