#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createIntegrationCredentialKeyAttestation,
  deriveIntegrationCredentialEncryptionKey,
} from '../app_src/lib/integrations/integrationCredentialKeyAttestation.mjs'
import {
  IntegrationCredentialRuntimeGateError,
  INTEGRATION_CREDENTIAL_RUNTIME_PROOF_TTL_MS,
  assertIntegrationCredentialProviderIoReady,
  createIntegrationCredentialRuntimeProof,
  integrationCredentialRuntimeEncryptionKey,
  isIntegrationCredentialRuntimeGateError,
  readIntegrationCredentialRuntimeAttestation,
  refreshIntegrationCredentialRuntimeReadiness,
  resolveIntegrationCredentialRuntimeConfiguration,
  scheduleIntegrationCredentialRuntimeRefresh,
  verifyIntegrationCredentialRuntimeProof,
  verifyIntegrationCredentialRuntimeReadiness,
} from '../app_src/lib/integrations/integrationCredentialRuntimeGate.mjs'

const root = resolve(import.meta.dirname, '..')
const databaseIdentity = '10000000-0000-4000-8000-000000000901'
const keyId = 'production-integration-v1'
const keyMaterial = 'production-integration-runtime-test-key-000000000001'

function environment(overrides = {}) {
  return {
    RAILWAY_ENVIRONMENT_NAME: 'production',
    RAILWAY_DEPLOYMENT_ID: 'deployment-runtime-test-1',
    DATABASE_URL: 'postgresql://runtime:test@db.example.test:5432/clawpilot',
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: keyId,
    ...overrides,
  }
}

function sentinel({
  secret = keyMaterial,
  id = keyId,
  ciphertextMutation = false,
} = {}) {
  const generated = createIntegrationCredentialKeyAttestation({
    databaseIdentity,
    keyId: id,
    keyMaterial: secret,
  })
  const ciphertext = Buffer.from(generated.sentinelCiphertext)
  if (ciphertextMutation) ciphertext[0] ^= 0xff
  return {
    singleton_id: 1,
    attestation_version: generated.attestationVersion,
    database_identity: generated.databaseIdentity,
    key_id: generated.keyId,
    sentinel_ciphertext: ciphertext,
    sentinel_iv: generated.sentinelIv,
    sentinel_tag: generated.sentinelTag,
    bootstrap_mode: 'reviewed_adoption',
    adoption_evidence_sha256: 'a'.repeat(64),
    created_by: 'operator@example.test',
    created_at: new Date('2026-09-04T12:00:00.000Z'),
  }
}

const typedRuntimeMaintenanceError = new IntegrationCredentialRuntimeGateError(
  'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
)
assert.equal(
  isIntegrationCredentialRuntimeGateError(typedRuntimeMaintenanceError),
  true,
)
assert.equal(
  isIntegrationCredentialRuntimeGateError(
    Object.assign(new Error('same code, wrong type'), {
      code: 'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
    }),
  ),
  false,
  'maintenance classification must remain typed rather than code-string based',
)

function client(record, {
  schemaValid = true,
  productImageRuntimeParkingValid = schemaValid,
} = {}) {
  return {
    calls: [],
    async query(sql, values = []) {
      this.calls.push({ sql, values })
      if (sql.includes('to_regclass')) {
        return {
          rows: [{
            attestation_table:
              'operations_integration_credential_key_attestations',
            attestation_migration_applied: true,
            product_image_import_jobs_table:
              'operations_commerce_product_image_import_jobs',
            product_image_runtime_parking_migration_applied:
              productImageRuntimeParkingValid,
            product_image_runtime_parking_function_valid:
              productImageRuntimeParkingValid,
            product_image_runtime_parking_trigger_valid:
              productImageRuntimeParkingValid,
            database_identity: databaseIdentity,
            attestation_columns_valid: schemaValid,
            attestation_constraints_valid: schemaValid,
            attestation_triggers_valid: schemaValid,
            attestation_functions_valid: schemaValid,
            attestation_privileges_valid: schemaValid,
          }],
        }
      }
      if (sql.includes('FROM public.operations_integration_credential')) {
        return { rows: record ? [record] : [] }
      }
      throw new Error('unexpected query')
    },
  }
}

async function strictReady() {
  const runtimeEnvironment = environment()
  const durableSentinel = sentinel()
  const durable = await readIntegrationCredentialRuntimeAttestation({
    client: client(durableSentinel),
    environment: runtimeEnvironment,
  })
  assert.equal(durable.status, 'verified')
  assert.equal(durable.providerIoReady, true)
  const proof = createIntegrationCredentialRuntimeProof(durable, {
    environment: runtimeEnvironment,
  })
  const readyEnvironment = {
    ...runtimeEnvironment,
    INTEGRATION_CREDENTIAL_RUNTIME_PROOF: proof,
  }
  const readiness = await verifyIntegrationCredentialRuntimeReadiness({
    client: client(durableSentinel),
    environment: readyEnvironment,
  })
  assert.equal(readiness.status, 'verified')
  assert.equal(readiness.proofVerified, true)
  const actualKey = integrationCredentialRuntimeEncryptionKey({
    environment: readyEnvironment,
  })
  const expectedKey = deriveIntegrationCredentialEncryptionKey(keyMaterial)
  try {
    assert.deepEqual(actualKey, expectedKey)
  } finally {
    actualKey.fill(0)
    expectedKey.fill(0)
  }
}

await strictReady()

assert.throws(
  () => resolveIntegrationCredentialRuntimeConfiguration({
    environment: environment({
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: '',
      AGENT_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    }),
    hosted: false,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_KEY_REQUIRED/u,
  'a caller override must not downgrade a hosted runtime or substitute an agent key',
)

const injectedLocalConfiguration = Object.freeze({
  hosted: false,
  mode: 'local',
  keyId: 'injected-local-key',
  adoptionDeadline: null,
})
const downgradeAttemptEnvironment = environment()
assert.throws(
  () => verifyIntegrationCredentialRuntimeProof({
    environment: downgradeAttemptEnvironment,
    configuration: injectedLocalConfiguration,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_REQUIRED/u,
  'proof verification must derive hosted status from the Railway environment',
)
assert.throws(
  () => assertIntegrationCredentialProviderIoReady({
    environment: downgradeAttemptEnvironment,
    configuration: injectedLocalConfiguration,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_REQUIRED/u,
  'the provider boundary must reject an injected non-hosted configuration',
)
const downgradeAttemptClient = client(sentinel())
const downgradeAttemptReadiness =
  await refreshIntegrationCredentialRuntimeReadiness({
    client: downgradeAttemptClient,
    environment: downgradeAttemptEnvironment,
    configuration: injectedLocalConfiguration,
    allowMissingProof: true,
  })
assert.equal(downgradeAttemptReadiness.status, 'verified')
assert.equal(downgradeAttemptReadiness.providerIoReady, true)
assert.equal(downgradeAttemptReadiness.proofRefreshed, true)
assert.equal(downgradeAttemptClient.calls.length, 2)
assert.equal(
  verifyIntegrationCredentialRuntimeProof({
    environment: downgradeAttemptEnvironment,
    configuration: injectedLocalConfiguration,
  }).status,
  'verified',
)
assert.equal(
  assertIntegrationCredentialProviderIoReady({
    environment: downgradeAttemptEnvironment,
    configuration: injectedLocalConfiguration,
  }).status,
  'verified',
)

{
  const hostedNames = [
    'RAILWAY_ENVIRONMENT_NAME',
    'RAILWAY_DEPLOYMENT_ID',
    'DATABASE_URL',
    'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY',
    'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID',
    'INTEGRATION_CREDENTIAL_ATTESTATION_MODE',
    'INTEGRATION_CREDENTIAL_RUNTIME_PROOF',
  ]
  const original = Object.fromEntries(
    hostedNames.map((name) => [name, process.env[name]]),
  )
  try {
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production'
    process.env.RAILWAY_DEPLOYMENT_ID = 'actual-hosted-process'
    process.env.DATABASE_URL =
      'postgresql://runtime:test@actual-hosted.example.test:5432/clawpilot'
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = keyMaterial
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID = keyId
    process.env.INTEGRATION_CREDENTIAL_ATTESTATION_MODE = 'strict'
    delete process.env.INTEGRATION_CREDENTIAL_RUNTIME_PROOF
    const injectedLocalEnvironment = {
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    }
    assert.throws(
      () => assertIntegrationCredentialProviderIoReady({
        environment: injectedLocalEnvironment,
      }),
      /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_REQUIRED/u,
      'a caller-supplied local environment must not downgrade the actual hosted process',
    )
    assert.throws(
      () => integrationCredentialRuntimeEncryptionKey({
        environment: injectedLocalEnvironment,
      }),
      /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_REQUIRED/u,
      'the crypto boundary must not accept a local environment inside an actual hosted process',
    )
  } finally {
    for (const name of hostedNames) {
      if (original[name] === undefined) delete process.env[name]
      else process.env[name] = original[name]
    }
  }
}

{
  const hostedNames = [
    'VERCEL',
    'VERCEL_ENV',
    'VERCEL_DEPLOYMENT_ID',
    'VERCEL_URL',
    'APP_SESSION_SECRET',
  ]
  const original = Object.fromEntries(
    hostedNames.map((name) => [name, process.env[name]]),
  )
  try {
    const vercelMarkers = [
      ['VERCEL', '1'],
      ['VERCEL_ENV', 'preview'],
      ['VERCEL_DEPLOYMENT_ID', 'dpl_runtime_marker'],
      ['VERCEL_URL', 'clawpilot-preview.example.test'],
    ]
    for (const [marker, markerValue] of vercelMarkers) {
      for (const name of hostedNames) delete process.env[name]
      process.env[marker] = markerValue
      process.env.APP_SESSION_SECRET =
        'actual-vercel-preview-session-key-000000000000000001'
      const injectedLocalEnvironment = {
        INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
      }
      assert.throws(
        () => assertIntegrationCredentialProviderIoReady({
          environment: injectedLocalEnvironment,
        }),
        /INTEGRATION_CREDENTIAL_RUNTIME_PROVIDER_IO_DISABLED/u,
        `${marker} must prevent a caller-supplied local environment from enabling provider I/O`,
      )
      assert.throws(
        () => integrationCredentialRuntimeEncryptionKey({
          environment: injectedLocalEnvironment,
        }),
        /INTEGRATION_CREDENTIAL_RUNTIME_PROVIDER_IO_DISABLED/u,
        `${marker} must prevent local credential fallback in an actual Vercel process`,
      )
    }
  } finally {
    for (const name of hostedNames) {
      if (original[name] === undefined) delete process.env[name]
      else process.env[name] = original[name]
    }
  }
}

const refreshFailureEnvironment = environment()
await refreshIntegrationCredentialRuntimeReadiness({
  client: client(sentinel()),
  environment: refreshFailureEnvironment,
  allowMissingProof: true,
})
await assert.rejects(
  refreshIntegrationCredentialRuntimeReadiness({
    client: {
      async query() {
        throw new Error('simulated direct database outage')
      },
    },
    environment: refreshFailureEnvironment,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED/u,
)
assert.equal(
  refreshFailureEnvironment.INTEGRATION_CREDENTIAL_RUNTIME_PROOF,
  undefined,
  'a direct durable refresh failure must remove the provider proof',
)
assert.throws(
  () => assertIntegrationCredentialProviderIoReady({
    environment: refreshFailureEnvironment,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE/u,
  'a failed direct refresh must revoke the process even if proof clearing fails',
)
await refreshIntegrationCredentialRuntimeReadiness({
  client: client(sentinel()),
  environment: refreshFailureEnvironment,
  allowMissingProof: true,
})
const refreshTimer = scheduleIntegrationCredentialRuntimeRefresh({
  client: {
    async query() {
      throw new Error('simulated database outage')
    },
  },
  environment: refreshFailureEnvironment,
  intervalMs: 5,
})
await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
assert.equal(
  refreshFailureEnvironment.INTEGRATION_CREDENTIAL_RUNTIME_PROOF,
  undefined,
  'any durable refresh failure must remove the provider crypto proof',
)
clearInterval(refreshTimer)

await assert.rejects(
  readIntegrationCredentialRuntimeAttestation({
    client: client(null),
    environment: environment(),
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_ATTESTATION_REQUIRED/u,
  'strict hosted mode must reject a missing sentinel',
)

await assert.rejects(
  readIntegrationCredentialRuntimeAttestation({
    client: client(sentinel()),
    environment: environment({
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY:
        'wrong-production-runtime-key-0000000000000000000001',
    }),
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_ATTESTATION_INVALID/u,
  'the wrong integration key must fail without provider access',
)

await assert.rejects(
  readIntegrationCredentialRuntimeAttestation({
    client: client(sentinel()),
    environment: environment({
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: 'wrong-key-id',
    }),
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_ATTESTATION_INVALID/u,
  'the wrong non-secret key ID must fail closed',
)

await assert.rejects(
  readIntegrationCredentialRuntimeAttestation({
    client: client(sentinel({ ciphertextMutation: true })),
    environment: environment(),
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_ATTESTATION_INVALID/u,
  'tampered sentinel ciphertext must fail closed',
)

await assert.rejects(
  readIntegrationCredentialRuntimeAttestation({
    client: client(sentinel(), { schemaValid: false }),
    environment: environment(),
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED/u,
  'a drifted live attestation schema must fail closed despite its ledger row',
)

await assert.rejects(
  readIntegrationCredentialRuntimeAttestation({
    client: client(sentinel(), {
      productImageRuntimeParkingValid: false,
    }),
    environment: environment(),
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED/u,
  'provider I/O must remain disabled until exact 0357 runtime parking is ready',
)

assert.throws(
  () => resolveIntegrationCredentialRuntimeConfiguration({
    environment: {
      CLAWPILOT_STORAGE: 'postgres',
      DATABASE_URL: 'postgresql://runtime:test@db.example.test:5432/clawpilot',
      AGENT_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    },
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_KEY_REQUIRED/u,
  'a Postgres-backed runtime must not bypass enforcement off-platform',
)

const bareVercelConfiguration =
  resolveIntegrationCredentialRuntimeConfiguration({
    environment: {
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      APP_SESSION_SECRET: 'preview-session-only-key-00000000000000000001',
    },
  })
assert.equal(
  bareVercelConfiguration.hosted,
  false,
  'a Vercel compile/UI preview without authenticated Postgres is not a production runtime',
)
assert.equal(
  verifyIntegrationCredentialRuntimeProof({
    environment: {
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      APP_SESSION_SECRET: 'preview-session-only-key-00000000000000000001',
    },
  }).providerIoReady,
  false,
  'a bare Vercel preview must keep provider I/O disabled',
)
for (const [marker, markerValue] of [
  ['VERCEL', '1'],
  ['VERCEL_ENV', 'preview'],
  ['VERCEL_DEPLOYMENT_ID', 'dpl_runtime_marker'],
  ['VERCEL_URL', 'clawpilot-preview.example.test'],
]) {
  assert.equal(
    verifyIntegrationCredentialRuntimeProof({
      environment: {
        [marker]: markerValue,
        APP_SESSION_SECRET:
          'preview-session-only-key-00000000000000000001',
      },
    }).providerIoReady,
    false,
    `${marker} alone must keep Vercel provider I/O disabled`,
  )
}
const bareVercelRefreshEnvironment = {
  VERCEL: '1',
  VERCEL_ENV: 'preview',
  APP_SESSION_SECRET: 'preview-session-only-key-00000000000000000001',
}
const bareVercelReadiness =
  await refreshIntegrationCredentialRuntimeReadiness({
    environment: bareVercelRefreshEnvironment,
    client: {
      async query() {
        throw new Error('a bare Vercel preview must not read PostgreSQL')
      },
    },
  })
assert.equal(bareVercelReadiness.mode, 'preview')
assert.equal(bareVercelReadiness.status, 'preview')
assert.equal(bareVercelReadiness.providerIoReady, false)
assert.equal(bareVercelReadiness.deploymentReady, true)
assert.equal(bareVercelReadiness.proofVerified, true)
assert.equal(bareVercelReadiness.proofRefreshed, false)
assert.equal(
  bareVercelRefreshEnvironment.INTEGRATION_CREDENTIAL_RUNTIME_PROOF,
  undefined,
  'a bare Vercel readiness refresh must not install a provider proof',
)
let bareVercelProviderCalls = 0
assert.throws(
  () => {
    assertIntegrationCredentialProviderIoReady({
      environment: {
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        APP_SESSION_SECRET: 'preview-session-only-key-00000000000000000001',
      },
    })
    bareVercelProviderCalls += 1
  },
  /INTEGRATION_CREDENTIAL_RUNTIME_PROVIDER_IO_DISABLED/u,
  'a bare Vercel preview must not call an integration provider',
)
assert.equal(bareVercelProviderCalls, 0)
assert.throws(
  () => resolveIntegrationCredentialRuntimeConfiguration({
    environment: {
      VERCEL: '1',
      CLAWPILOT_STORAGE: 'postgres',
      DATABASE_URL: 'postgresql://runtime:test@db.example.test:5432/clawpilot',
      CLAWPILOT_DB_FALLBACK_TO_FILE: 'false',
      APP_AUTH_REQUIRED: '1',
      AGENT_CREDENTIAL_ENCRYPTION_KEY: keyMaterial,
    },
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_KEY_REQUIRED/u,
  'Vercel with authenticated Postgres must require the dedicated integration key',
)

const adoptionEnvironment = environment({
  INTEGRATION_CREDENTIAL_ATTESTATION_MODE: 'adoption',
  INTEGRATION_CREDENTIAL_ATTESTATION_ADOPTION_DEADLINE:
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
})
const adoptionState = await readIntegrationCredentialRuntimeAttestation({
  client: client(null),
  environment: adoptionEnvironment,
})
assert.equal(adoptionState.status, 'adoption_required')
assert.equal(adoptionState.deploymentReady, true)
assert.equal(adoptionState.providerIoReady, false)
const adoptionProof = createIntegrationCredentialRuntimeProof(adoptionState, {
  environment: adoptionEnvironment,
})
const adoptionReadyEnvironment = {
  ...adoptionEnvironment,
  INTEGRATION_CREDENTIAL_RUNTIME_PROOF: adoptionProof,
}
const adoptionReadiness = await verifyIntegrationCredentialRuntimeReadiness({
  client: client(null),
  environment: adoptionReadyEnvironment,
})
assert.equal(adoptionReadiness.deploymentReady, true)
assert.equal(adoptionReadiness.providerIoReady, false)
assert.throws(
  () => integrationCredentialRuntimeEncryptionKey({
    environment: adoptionReadyEnvironment,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_PROVIDER_IO_DISABLED/u,
  'adoption mode must never release integration key bytes to provider crypto',
)

await assert.rejects(
  readIntegrationCredentialRuntimeAttestation({
    client: client(sentinel()),
    environment: adoptionReadyEnvironment,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_ADOPTION_COMPLETE_STRICT_REQUIRED/u,
  'a completed attestation must not remain in adoption mode',
)

assert.throws(
  () => resolveIntegrationCredentialRuntimeConfiguration({
    environment: environment({
      INTEGRATION_CREDENTIAL_ATTESTATION_MODE: 'adoption',
      INTEGRATION_CREDENTIAL_ATTESTATION_ADOPTION_DEADLINE:
        new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    }),
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_ADOPTION_DEADLINE_INVALID/u,
  'adoption mode must have a bounded deadline',
)

const refreshEnvironment = environment()
const refreshed = await refreshIntegrationCredentialRuntimeReadiness({
  client: client(sentinel()),
  environment: refreshEnvironment,
  allowMissingProof: true,
})
assert.equal(refreshed.proofRefreshed, true)
assert.ok(refreshEnvironment.INTEGRATION_CREDENTIAL_RUNTIME_PROOF)

let releaseSlowRefresh
let markSlowRefreshStarted
const slowRefreshStarted = new Promise((resolvePromise) => {
  markSlowRefreshStarted = resolvePromise
})
const slowRefreshRelease = new Promise((resolvePromise) => {
  releaseSlowRefresh = resolvePromise
})
const slowSuccessClient = client(sentinel())
const originalSlowSuccessQuery = slowSuccessClient.query.bind(slowSuccessClient)
let firstSlowQuery = true
slowSuccessClient.query = async (sql, values = []) => {
  if (firstSlowQuery) {
    firstSlowQuery = false
    markSlowRefreshStarted()
    await slowRefreshRelease
  }
  return originalSlowSuccessQuery(sql, values)
}
const concurrentRefreshEnvironment = environment()
const olderSlowSuccess = refreshIntegrationCredentialRuntimeReadiness({
  client: slowSuccessClient,
  environment: concurrentRefreshEnvironment,
  allowMissingProof: true,
})
await slowRefreshStarted
const newerFailure = refreshIntegrationCredentialRuntimeReadiness({
  client: {
    async query() {
      throw new Error('simulated newer database outage')
    },
  },
  environment: concurrentRefreshEnvironment,
  allowMissingProof: true,
})
releaseSlowRefresh()
await olderSlowSuccess
await assert.rejects(
  newerFailure,
  /INTEGRATION_CREDENTIAL_RUNTIME_SCHEMA_REQUIRED/u,
)
assert.equal(
  concurrentRefreshEnvironment.INTEGRATION_CREDENTIAL_RUNTIME_PROOF,
  undefined,
  'an older slow success must not overwrite a newer failed refresh',
)
assert.throws(
  () => assertIntegrationCredentialProviderIoReady({
    environment: concurrentRefreshEnvironment,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE/u,
  'the newer failed refresh must leave the process revoked',
)

function expectProviderBoundaryFailure({
  runtimeEnvironment,
  now,
  expected,
  label,
}) {
  let providerCalls = 0
  const keyBackedState = { writes: 0 }
  assert.throws(
    () => {
      assertIntegrationCredentialProviderIoReady({
        environment: runtimeEnvironment,
        now,
      })
      providerCalls += 1
      keyBackedState.writes += 1
    },
    expected,
    label,
  )
  assert.equal(providerCalls, 0, `${label}: provider call must not run`)
  assert.deepEqual(
    keyBackedState,
    { writes: 0 },
    `${label}: key-backed state must remain unchanged`,
  )
}

expectProviderBoundaryFailure({
  runtimeEnvironment: environment(),
  expected: /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_REQUIRED/u,
  label: 'a missing proof must stop the provider boundary',
})
expectProviderBoundaryFailure({
  runtimeEnvironment: {
    ...refreshEnvironment,
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY:
      'wrong-production-runtime-key-0000000000000000000001',
  },
  expected: /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID/u,
  label: 'a wrong key must stop the provider boundary',
})
expectProviderBoundaryFailure({
  runtimeEnvironment: {
    ...refreshEnvironment,
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: 'wrong-key-id',
  },
  expected: /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_INVALID/u,
  label: 'a wrong key ID must stop the provider boundary',
})

const proofNow = Date.now()
const expiryEnvironment = environment()
const expiryAttestation = await readIntegrationCredentialRuntimeAttestation({
  client: client(sentinel()),
  environment: expiryEnvironment,
  now: proofNow,
})
const expiringProof = createIntegrationCredentialRuntimeProof(
  expiryAttestation,
  {
    environment: expiryEnvironment,
    now: proofNow,
  },
)
const expiringEnvironment = {
  ...expiryEnvironment,
  INTEGRATION_CREDENTIAL_RUNTIME_PROOF: expiringProof,
}
expectProviderBoundaryFailure({
  runtimeEnvironment: expiringEnvironment,
  now: proofNow + INTEGRATION_CREDENTIAL_RUNTIME_PROOF_TTL_MS,
  expected: /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_EXPIRED/u,
  label: 'an expired proof must stop the provider boundary',
})
assert.throws(
  () => verifyIntegrationCredentialRuntimeProof({
    environment: expiryEnvironment,
    proof: expiringProof,
    now: proofNow + INTEGRATION_CREDENTIAL_RUNTIME_PROOF_TTL_MS,
  }),
  /INTEGRATION_CREDENTIAL_RUNTIME_PROOF_EXPIRED/u,
  'provider crypto proofs must expire instead of authorizing forever',
)

const startup = readFileSync(resolve(root, 'scripts/start-railway.sh'), 'utf8')
const verifierPosition = startup.indexOf(
  'node scripts/verify-integration-credential-runtime.mjs',
)
const applicationPosition = startup.indexOf('npm run start &')
assert.ok(verifierPosition >= 0 && verifierPosition < applicationPosition)
for (const required of [
  'require_value INTEGRATION_CREDENTIAL_ENCRYPTION_KEY 32',
  'require_value INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID 1',
  'INTEGRATION_CREDENTIAL_ATTESTATION_MODE:-strict',
  'INTEGRATION_CREDENTIAL_ATTESTATION_ADOPTION_DEADLINE',
  'export INTEGRATION_CREDENTIAL_RUNTIME_PROOF',
  'the pipeline outbox poller is suppressed',
  'normal release recording is suppressed',
]) {
  assert.ok(startup.includes(required), `Railway startup is missing ${required}`)
}
const strictWorkerGatePosition = startup.indexOf(
  'if [[ "${INTEGRATION_CREDENTIAL_ATTESTATION_MODE:-strict}" == "strict" ]]; then',
)
const workerStartPosition = startup.indexOf(
  'node scripts/pipeline-outbox-poller.mjs &',
)
const workerSuppressionPosition = startup.indexOf(
  'the pipeline outbox poller is suppressed',
)
assert.ok(
  strictWorkerGatePosition >= 0
    && strictWorkerGatePosition < workerStartPosition
    && workerStartPosition < workerSuppressionPosition,
  'Railway must start the outbox poller only inside the strict-mode branch',
)
assert.ok(
  startup.includes('if [[ -n "$WORKER_PID" ]]; then'),
  'Railway liveness must tolerate the intentionally absent adoption worker',
)

const health = readFileSync(
  resolve(root, 'app_src/app/api/health/route.ts'),
  'utf8',
)
assert.ok(health.includes('refreshIntegrationCredentialRuntimeReadiness'))
assert.ok(health.includes('allowMissingProof: true'))
assert.ok(health.includes('integrationCredentialRuntime'))
assert.ok(health.includes('providerIoReady: false'))
assert.ok(!health.includes('keyId'))

function assertProviderBoundaryPrecedes(
  relativePath,
  functionName,
  unsafeMarker,
) {
  const source = readFileSync(resolve(root, relativePath), 'utf8')
  const functionStart = source.indexOf(`export async function ${functionName}`)
  assert.ok(functionStart >= 0, `${functionName} must exist`)
  const nextFunction = source.indexOf('\nexport async function ', functionStart + 1)
  const body = source.slice(
    functionStart,
    nextFunction < 0 ? source.length : nextFunction,
  )
  const boundary = body.indexOf('assertIntegrationCredentialProviderIoReady()')
  const unsafe = body.indexOf(unsafeMarker)
  assert.ok(boundary >= 0, `${functionName} must assert provider readiness`)
  assert.ok(unsafe >= 0, `${functionName} must retain ${unsafeMarker}`)
  assert.ok(
    boundary < unsafe,
    `${functionName} must attest before ${unsafeMarker}`,
  )
}

for (const [relativePath, functionName, unsafeMarker] of [
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'getCommerceIntegrationsState',
    'purgeExpiredShopifyOrderPreviewsInPostgres()',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'startFaireOAuthCommerce',
    'encryptFaireOAuthPendingCredential(',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'purgeExpiredFaireOAuthCommerce',
    'purgeExpiredFaireOAuthInstallationsInPostgres()',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'discardFaireOAuthCommerce',
    'discardFaireOAuthInstallationInPostgres({',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'completeFaireOAuthCommerce',
    'claimFaireOAuthInstallationInPostgres({',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'connectShopifyCommerce',
    'requestShopifyAccessToken({',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'connectFaireCommerce',
    'probeFaireBrandProfile({',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'clearShopifyOrderPreview',
    'clearShopifyOrderPreviewInPostgres({',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'importShopifyOrderPreview',
    'shopifyPreviewFetchRuntime(input)',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'testCommerceConnection',
    'storedRuntime(input)',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'reconcileShopifyOrderWebhookSetup',
    'storedRuntime(input)',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'setCommerceIntegrationEnabled',
    'storedRuntime(input)',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'setShopifyFulfillmentNotificationPolicy',
    'updateShopifyFulfillmentNotificationPolicyInPostgres({',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'disconnectCommerceIntegration',
    'storedRuntime(input)',
  ],
  [
    'app_src/lib/integrations/commerceIntegrations.ts',
    'receiveShopifyWebhook',
    'readCommerceWebhookCredentialFromPostgres(',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'createCarrierAccount',
    'createCarrierAccountInPostgres(',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'updateCarrierAccount',
    'updateCarrierAccountInPostgres({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'setCarrierAccountStatus',
    'setCarrierAccountStatusInPostgres({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'deleteCarrierAccount',
    'deleteCarrierAccountInPostgres({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'updateCarrierCredential',
    'verifyCarrierCredential({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'testCarrierCredential',
    'verifyCarrierCredential({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'testCarrierSandboxRate',
    'requestCarrierSandboxRates({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'testCarrierSandboxShipmentRate',
    'requestCarrierSandboxShipmentRates({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'setCarrierProductionLabelEnabled',
    'setCarrierProductionLabelCapabilityInPostgres({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'setCarrierIntegrationEnabled',
    'setCarrierIntegrationEnabledInPostgres({',
  ],
  [
    'app_src/lib/integrations/carrierIntegrations.ts',
    'disconnectCarrierCredential',
    'disconnectCarrierCredentialInPostgres({',
  ],
  [
    'app_src/lib/integrations/brokeredTransportIntegrations.ts',
    'updateBrokeredTransportCredential',
    'withTransaction(async (client)',
  ],
  [
    'app_src/lib/integrations/brokeredTransportIntegrations.ts',
    'verifyAndActivateBrokeredTransportRates',
    'verifyWwexSpeedshipRuntimeCredential({',
  ],
  [
    'app_src/lib/integrations/brokeredTransportIntegrations.ts',
    'disconnectBrokeredTransportCredential',
    'withTransaction(async (client)',
  ],
  [
    'app_src/lib/integrations/brokeredTransportIntegrations.ts',
    'readActiveBrokeredTransportRuntimeCredential',
    'query<ConnectionRow>(',
  ],
]) {
  assertProviderBoundaryPrecedes(relativePath, functionName, unsafeMarker)
}

for (const relativePath of [
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
  'app_src/lib/integrations/carrierCredentialCrypto.ts',
  'app_src/lib/integrations/brokeredTransportCredentialCrypto.ts',
  'app_src/lib/integrations/shopifyCarrierServiceCallback.ts',
]) {
  const source = readFileSync(resolve(root, relativePath), 'utf8')
  assert.ok(
    source.includes('integrationCredentialRuntimeEncryptionKey'),
    `${relativePath} must use the centralized runtime key gate`,
  )
  assert.ok(
    !source.includes(
      'process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY\n    || process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY',
    ),
    `${relativePath} must not retain the hosted agent-key fallback`,
  )
}

for (const relativePath of [
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
  'app_src/lib/integrations/carrierCredentialCrypto.ts',
  'app_src/lib/integrations/brokeredTransportCredentialCrypto.ts',
]) {
  const source = readFileSync(resolve(root, relativePath), 'utf8')
  assert.equal(
    source.match(/integrationCredentialRuntimeEncryptionKey\(/gu)?.length,
    1,
    `${relativePath} must acquire the integration key only in its zeroizing helper`,
  )
  assert.match(
    source,
    /function withEncryptionKey<[\s\S]*?try \{[\s\S]*?finally \{\s*key\.fill\(0\)\s*\}/u,
    `${relativePath} must zero each acquired integration key in finally`,
  )
  assert.ok(
    source.includes(
      'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
    ),
    `${relativePath} must preserve typed runtime maintenance errors`,
  )
}

for (const [relativePath, claimMarker, parkMarker] of [
  [
    'app_src/lib/faireInventoryPollingWorker.ts',
    'claimFaireInventoryPollJobsInPostgres(',
    'parkFaireInventoryPollForRuntimeMaintenanceInPostgres(',
  ],
  [
    'app_src/lib/commerceCatalogSyncWorker.ts',
    'claimCommerceCatalogSyncJobsInPostgres(',
    'parkCommerceCatalogSyncJobForRuntimeMaintenanceInPostgres(',
  ],
  [
    'app_src/lib/commerceOrderHistoryWorker.ts',
    'claimCommerceOrderBackfillsInPostgres(',
    'parkCommerceOrderBackfillForRuntimeMaintenanceInPostgres(',
  ],
  [
    'app_src/lib/shopifyInventoryRefreshWorker.ts',
    'claimShopifyInventoryRefreshJobsInPostgres(',
    'parkShopifyInventoryRefreshForRuntimeMaintenanceInPostgres(',
  ],
  [
    'app_src/lib/shopifyOrderWebhookWorker.ts',
    'claimShopifyOrderWebhookTargetsInPostgres(',
    'parkShopifyOrderWebhookExactReadForRuntimeMaintenanceInPostgres(',
  ],
  [
    'app_src/lib/commerceShopifyOrderRevisionWorker.ts',
    'claimCommerceOrderRevisionTargetsInPostgres(',
    'parkCommerceOrderRevisionTargetForRuntimeMaintenanceInPostgres(',
  ],
  [
    'app_src/lib/commerceFaireOrderRevisionWorker.ts',
    'claimCommerceOrderRevisionTargetsInPostgres(',
    'parkCommerceOrderRevisionTargetForRuntimeMaintenanceInPostgres(',
  ],
  [
    'app_src/lib/commerceOrderReconciliationWorker.ts',
    'claimCommerceOrderReconciliationTargetsInPostgres(',
    'parkCommerceOrderReconciliationForRuntimeMaintenanceInPostgres(',
  ],
]) {
  const source = readFileSync(resolve(root, relativePath), 'utf8')
  const firstReadiness = source.indexOf(
    'assertIntegrationCredentialProviderIoReady()',
  )
  const firstClaim = source.indexOf(claimMarker)
  assert.ok(
    firstReadiness >= 0 && firstReadiness < firstClaim,
    `${relativePath} must attest before claiming provider work`,
  )
  assert.ok(
    source.includes('isIntegrationCredentialRuntimeGateError(error)'),
    `${relativePath} must classify typed runtime maintenance`,
  )
  assert.ok(
    source.includes(parkMarker),
    `${relativePath} must park claimed work during runtime maintenance`,
  )
}

for (const relativePath of [
  'app_src/app/api/integrations/commerce/catalog/process/route.ts',
  'app_src/app/api/integrations/commerce/images/process/route.ts',
  'app_src/app/api/integrations/commerce/inventory/process/route.ts',
  'app_src/app/api/integrations/commerce/orders/process/route.ts',
]) {
  const source = readFileSync(resolve(root, relativePath), 'utf8')
  assert.ok(source.includes('isIntegrationCredentialRuntimeGateError('))
  assert.ok(source.includes('status: 503'))
  assert.ok(source.includes("'Retry-After': '60'"))
}

const ordersProcessRoute = readFileSync(
  resolve(
    root,
    'app_src/app/api/integrations/commerce/orders/process/route.ts',
  ),
  'utf8',
)
for (const helperName of [
  'processCommerceOrderHistoryIsolated',
  'processShopifyOrderWebhookSignalsIsolated',
]) {
  const helperStart = ordersProcessRoute.indexOf(`async function ${helperName}`)
  const helperEnd = ordersProcessRoute.indexOf('\nasync function ', helperStart + 1)
  const helperBody = ordersProcessRoute.slice(
    helperStart,
    helperEnd < 0 ? ordersProcessRoute.length : helperEnd,
  )
  assert.ok(helperStart >= 0)
  assert.ok(
    helperBody.includes(
      'if (isIntegrationCredentialRuntimeGateError(error)) throw error',
    ),
    `${helperName} must not degrade typed maintenance into a successful response`,
  )
}

const heldDeleteSource = readFileSync(
  resolve(root, 'app_src/lib/persistence/commerceIntegrations.ts'),
  'utf8',
)
const heldDeleteStart = heldDeleteSource.indexOf(
  'export async function replayHeldShopifyProductDeletionsInPostgres',
)
const heldDeleteEnd = heldDeleteSource.indexOf(
  '\nexport async function ',
  heldDeleteStart + 1,
)
const heldDeleteBody = heldDeleteSource.slice(
  heldDeleteStart,
  heldDeleteEnd < 0 ? heldDeleteSource.length : heldDeleteEnd,
)
const heldDeleteRuntimeRethrow = heldDeleteBody.indexOf(
  'if (isIntegrationCredentialRuntimeGateError(error))',
)
const heldDeleteAttemptFailure = heldDeleteBody.indexOf('failed += 1')
assert.ok(
  heldDeleteRuntimeRethrow >= 0
    && heldDeleteRuntimeRethrow < heldDeleteAttemptFailure,
  'held Shopify deletion replay must rethrow maintenance before consuming attempts',
)

const callbackSource = readFileSync(
  resolve(
    root,
    'app_src/lib/integrations/shopifyCarrierServiceCallback.ts',
  ),
  'utf8',
)
const callbackFingerprintStart = callbackSource.indexOf(
  'function persistedRequestFingerprint',
)
const callbackFingerprintEnd = callbackSource.indexOf(
  '\nfunction fencedCacheKey',
  callbackFingerprintStart,
)
const callbackFingerprintBody = callbackSource.slice(
  callbackFingerprintStart,
  callbackFingerprintEnd,
)
assert.ok(
  callbackFingerprintBody.includes('fingerprintKey = callbackFingerprintKey()')
    && callbackFingerprintBody.includes('fingerprintKey?.fill(0)'),
  'Shopify callback fingerprinting must zero the derived key after HMAC use',
)

const instrumentation = readFileSync(
  resolve(root, 'app_src/instrumentation.ts'),
  'utf8',
)
assert.ok(instrumentation.includes("process.env.NEXT_RUNTIME !== 'nodejs'"))
assert.ok(instrumentation.includes('integrationCredentialRuntimeEnforcementRequired'))
assert.ok(instrumentation.includes('refreshIntegrationCredentialRuntimeReadiness'))
assert.ok(instrumentation.includes('allowMissingProof: true'))

const instrumentationUrl = pathToFileURL(
  resolve(root, 'app_src/instrumentation.ts'),
).href
for (const [label, runtimeEnvironment] of [
  ['file-backed local development', { CLAWPILOT_STORAGE: 'file' }],
  ['Vercel preview', { VERCEL: '1', VERCEL_ENV: 'preview' }],
]) {
  const childEnvironment = {
    NEXT_RUNTIME: 'nodejs',
    NODE_NO_WARNINGS: '1',
    ...runtimeEnvironment,
  }
  if (process.env.PATH) childEnvironment.PATH = process.env.PATH
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `const { register } = await import(${JSON.stringify(instrumentationUrl)}); await register(); process.stdout.write('skipped')`,
    ],
    {
      encoding: 'utf8',
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  assert.equal(
    output,
    'skipped',
    `${label} instrumentation must skip Postgres and key resolution without secrets`,
  )
}

console.log('PASS test-integration-credential-runtime-gate')
