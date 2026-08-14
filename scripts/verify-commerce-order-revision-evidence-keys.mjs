#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  CommerceOrderRevisionEvidenceKeyConfigError,
  resolveCommerceOrderRevisionEvidenceKeyConfig,
  summarizeCommerceOrderRevisionEvidenceKeyReadiness,
} from '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'

const MIGRATION = '0274_operations_commerce_order_revision_apply.sql'
const READ_TABLE = 'operations_commerce_order_revision_reads'
const REQUIRED_COLUMNS = [
  'party_snapshot_key_id',
  'protected_snapshot_purged_at',
  'ship_to_snapshot_key_id',
]

class CommerceOrderRevisionEvidenceKeyVerificationError extends Error {
  constructor(code, safeDetails = {}) {
    super(code)
    this.name = 'CommerceOrderRevisionEvidenceKeyVerificationError'
    this.code = code
    this.safeDetails = safeDetails
  }
}

function fail(code, safeDetails) {
  throw new CommerceOrderRevisionEvidenceKeyVerificationError(
    code,
    safeDetails,
  )
}

function safeErrorCode(error) {
  if (
    error instanceof CommerceOrderRevisionEvidenceKeyConfigError
    || error instanceof CommerceOrderRevisionEvidenceKeyVerificationError
  ) {
    return error.code
  }
  return 'COMMERCE_ORDER_REVISION_EVIDENCE_KEY_VERIFICATION_FAILED'
}

function printSafe(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`)
}

async function readDatabaseReferences(pool) {
  const relationResult = await pool.query(
    `SELECT to_regclass('public.schema_migrations')::text
              AS migrations_table,
            to_regclass('public.operations_commerce_order_revision_reads')::text
              AS revision_reads_table`,
  )
  const relation = relationResult.rows[0] || {}
  if (!relation.migrations_table) {
    fail('COMMERCE_ORDER_REVISION_EVIDENCE_SCHEMA_MIGRATIONS_MISSING')
  }
  if (!relation.revision_reads_table) {
    fail('COMMERCE_ORDER_REVISION_EVIDENCE_READ_TABLE_MISSING')
  }

  const migrationResult = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM public.schema_migrations
       WHERE filename = $1
     ) AS applied`,
    [MIGRATION],
  )
  if (!migrationResult.rows[0]?.applied) {
    fail('COMMERCE_ORDER_REVISION_EVIDENCE_MIGRATION_REQUIRED')
  }

  const columnsResult = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = ANY($2::text[])
     ORDER BY column_name`,
    [READ_TABLE, REQUIRED_COLUMNS],
  )
  const actualColumns = columnsResult.rows.map((row) => row.column_name)
  if (
    actualColumns.length !== REQUIRED_COLUMNS.length
    || REQUIRED_COLUMNS.some((column) => !actualColumns.includes(column))
  ) {
    fail('COMMERCE_ORDER_REVISION_EVIDENCE_READ_SCHEMA_INCOMPLETE')
  }

  const referenceResult = await pool.query(
    `WITH unpurged_protected_reads AS MATERIALIZED (
       SELECT id, party_snapshot_key_id, ship_to_snapshot_key_id
       FROM public.operations_commerce_order_revision_reads
       WHERE protected_snapshot_purged_at IS NULL
         AND (
           party_snapshot_key_id IS NOT NULL
           OR ship_to_snapshot_key_id IS NOT NULL
         )
     ), referenced_keys AS (
       SELECT id AS read_id, party_snapshot_key_id AS key_id
       FROM unpurged_protected_reads
       WHERE party_snapshot_key_id IS NOT NULL
       UNION
       SELECT id AS read_id, ship_to_snapshot_key_id AS key_id
       FROM unpurged_protected_reads
       WHERE ship_to_snapshot_key_id IS NOT NULL
     )
     SELECT
       (SELECT count(*)::integer FROM unpurged_protected_reads)
         AS unpurged_protected_read_count,
       COALESCE(
         (
           SELECT array_agg(distinct_keys.key_id ORDER BY distinct_keys.key_id)
           FROM (
             SELECT DISTINCT key_id
             FROM referenced_keys
           ) distinct_keys
         ),
         ARRAY[]::text[]
       ) AS referenced_key_ids`,
  )
  const references = referenceResult.rows[0] || {}
  return {
    unpurgedProtectedReadCount: Number(
      references.unpurged_protected_read_count || 0,
    ),
    referencedKeyIds: Array.isArray(references.referenced_key_ids)
      ? references.referenced_key_ids
      : [],
  }
}

async function verifyDatabase() {
  const databaseUrl = String(process.env.DATABASE_URL || '')
  if (databaseUrl.length < 16) {
    fail('COMMERCE_ORDER_REVISION_EVIDENCE_DATABASE_URL_REQUIRED')
  }

  const configuration = resolveCommerceOrderRevisionEvidenceKeyConfig()
  const requireFromApp = createRequire(
    new URL('../app_src/package.json', import.meta.url),
  )
  const { Pool } = requireFromApp('pg')
  const sslMode = String(
    process.env.PGSSLMODE || process.env.DATABASE_SSL || '',
  ).toLowerCase()
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslMode === 'require' || sslMode === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    max: 1,
  })

  try {
    const references = await readDatabaseReferences(pool)
    const readiness = summarizeCommerceOrderRevisionEvidenceKeyReadiness(
      configuration,
      references,
    )
    if (!readiness.ready) {
      fail(
        'COMMERCE_ORDER_REVISION_EVIDENCE_REFERENCED_KEY_MISSING',
        {
          migration: MIGRATION,
          table: READ_TABLE,
          readiness,
        },
      )
    }
    printSafe({
      status: 'ready',
      migration: MIGRATION,
      table: READ_TABLE,
      ...readiness,
      checkedAt: new Date().toISOString(),
    })
  } finally {
    await pool.end().catch(() => undefined)
  }
}

function runSelfTest() {
  const fingerprintSecret = 'fingerprint-secret-that-is-at-least-32-characters'
  const keyOne = 'revision-key-one-that-is-at-least-32-characters'
  const keyTwo = 'revision-key-two-that-is-at-least-32-characters'
  const explicitEnvironment = {
    INTEGRATION_EVIDENCE_FINGERPRINT_KEY: fingerprintSecret,
    INTEGRATION_EVIDENCE_ACTIVE_KEY_ID: 'revision-k2',
    INTEGRATION_EVIDENCE_ENCRYPTION_KEYS: JSON.stringify({
      'revision-k1': keyOne,
      'revision-k2': keyTwo,
    }),
  }
  const explicit = resolveCommerceOrderRevisionEvidenceKeyConfig({
    environment: explicitEnvironment,
    hosted: true,
  })
  assert.equal(explicit.activeKeyId, 'revision-k2')
  assert.deepEqual(explicit.keyIds, ['revision-k1', 'revision-k2'])
  assert.equal(explicit.getFingerprintKeyMaterial(), fingerprintSecret)
  assert.equal(explicit.getEncryptionKeyMaterial('revision-k1'), keyOne)
  assert.equal(explicit.getEncryptionKeyMaterial('unknown'), null)
  const serialized = JSON.stringify(explicit)
  assert.equal(serialized.includes(fingerprintSecret), false)
  assert.equal(serialized.includes(keyOne), false)
  assert.equal(serialized.includes(keyTwo), false)

  const ready = summarizeCommerceOrderRevisionEvidenceKeyReadiness(explicit, {
    referencedKeyIds: ['revision-k2', 'revision-k1', 'revision-k1'],
    unpurgedProtectedReadCount: 3,
  })
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.referencedKeyIds, ['revision-k1', 'revision-k2'])
  assert.deepEqual(ready.missingReferencedKeyIds, [])
  const blocked = summarizeCommerceOrderRevisionEvidenceKeyReadiness(explicit, {
    referencedKeyIds: ['revision-k0', 'revision-k1'],
    unpurgedProtectedReadCount: 2,
  })
  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(blocked.missingReferencedKeyIds, ['revision-k0'])

  assert.throws(
    () => resolveCommerceOrderRevisionEvidenceKeyConfig({
      environment: {
        CLAWPILOT_ALLOW_LEGACY_REVISION_EVIDENCE_KEYS: '1',
        INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyOne,
      },
      hosted: true,
    }),
    (error) => error?.code
      === 'COMMERCE_ORDER_REVISION_EVIDENCE_FINGERPRINT_KEY_REQUIRED',
  )
  assert.throws(
    () => resolveCommerceOrderRevisionEvidenceKeyConfig({
      environment: {
        ...explicitEnvironment,
        INTEGRATION_EVIDENCE_ENCRYPTION_KEYS: '[]',
      },
      hosted: true,
    }),
    (error) => error?.code
      === 'COMMERCE_ORDER_REVISION_EVIDENCE_KEY_RING_INVALID',
  )
  assert.throws(
    () => resolveCommerceOrderRevisionEvidenceKeyConfig({
      environment: {
        ...explicitEnvironment,
        INTEGRATION_EVIDENCE_ACTIVE_KEY_ID: 'revision-k3',
      },
      hosted: true,
    }),
    (error) => error?.code
      === 'COMMERCE_ORDER_REVISION_EVIDENCE_ACTIVE_KEY_UNAVAILABLE',
  )

  const localLegacy = resolveCommerceOrderRevisionEvidenceKeyConfig({
    environment: {
      CLAWPILOT_ALLOW_LEGACY_REVISION_EVIDENCE_KEYS: '1',
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyOne,
    },
    hosted: false,
  })
  assert.equal(localLegacy.activeKeyId, 'legacy-v1')
  assert.equal(localLegacy.mode, 'local_legacy_compatibility')
  assert.equal(localLegacy.getFingerprintKeyMaterial(), keyOne)
  assert.equal(localLegacy.getEncryptionKeyMaterial('legacy-v1'), keyOne)
  assert.throws(
    () => resolveCommerceOrderRevisionEvidenceKeyConfig({
      environment: {
        INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyOne,
      },
      hosted: false,
    }),
    (error) => error?.code
      === 'COMMERCE_ORDER_REVISION_EVIDENCE_FINGERPRINT_KEY_REQUIRED',
  )

  printSafe({
    status: 'ready',
    selfTest: true,
    cases: 8,
  })
}

async function main() {
  const argumentsList = process.argv.slice(2)
  if (argumentsList.length === 1 && argumentsList[0] === '--self-test') {
    runSelfTest()
    return
  }
  if (argumentsList.length > 0) {
    fail('COMMERCE_ORDER_REVISION_EVIDENCE_ARGUMENT_INVALID')
  }
  await verifyDatabase()
}

main().catch((error) => {
  printSafe({
    status: 'blocked',
    errorCode: safeErrorCode(error),
    ...(
      error instanceof CommerceOrderRevisionEvidenceKeyVerificationError
        ? error.safeDetails
        : {}
    ),
  }, process.stderr)
  process.exitCode = 1
})
