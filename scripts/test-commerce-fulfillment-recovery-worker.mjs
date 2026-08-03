#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, { mocks = {} } = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(diagnostics, [])
  const loaded = { exports: {} }
  const sandbox = {
    Array,
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
    Set,
    String,
    Uint8Array,
    console,
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output.outputText, sandbox, { filename: path })
  return loaded.exports
}

function recoveryClaim(overrides = {}) {
  return {
    organizationId: '11111111-1111-4111-8111-111111111111',
    commerceExportGlobalId: 'gfe000000000001',
    actorEmail: 'operator@example.com',
    provider: 'faire',
    attempt: 1,
    priorState: 'queued',
    priorErrorCode: null,
    ...overrides,
  }
}

function codedError(code) {
  const error = new Error('sanitized test failure')
  error.code = code
  return error
}

const unused = async () => {
  throw new Error('Test must inject this dependency')
}
const worker = loadTypeScriptModule(
  'app_src/lib/commerceFulfillmentRecoveryWorker.ts',
  {
    mocks: {
      '@/lib/persistence/commerceFulfillmentRecovery': {
        claimCommerceFulfillmentRecoveryInPostgres: unused,
        COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT: 8,
        finalizeExhaustedCommerceFulfillmentRecoveriesInPostgres: unused,
      },
      '@/lib/persistence/operations': {
        executeOperationsCommerceFulfillmentExportFromPostgres: unused,
      },
    },
  },
)
const recoveryPolicy = loadTypeScriptModule(
  'app_src/lib/commerceFulfillmentRecoveryPolicy.ts',
)

test('a queued export executes once with its exact preclaim fence', async () => {
  const claims = [recoveryClaim({ actorEmail: null })]
  const executed = []
  const result = await worker.processCommerceFulfillmentRecovery(
    { limit: 1, workerId: 'recovery-worker-test' },
    {
      async finalizeExhausted() {
        return 0
      },
      async claim() {
        return claims.shift() || null
      },
      async execute(input) {
        executed.push(input)
        return {
          commerceExportGlobalId: input.commerceExportGlobalId,
          state: 'succeeded',
          providerReference: 'provider-reference',
          errorCode: null,
          errorMessage: null,
        }
      },
    },
  )

  assert.equal(result.claimed, 1)
  assert.equal(result.queuedClaims, 1)
  assert.equal(result.succeeded, 1)
  assert.equal(executed.length, 1)
  assert.equal(executed[0].actorEmail, null)
  assert.deepEqual(
    JSON.parse(JSON.stringify(executed[0].preclaimed)),
    {
      attempt: 1,
      priorState: 'queued',
      priorErrorCode: null,
      workerId: 'recovery-worker-test',
    },
  )
  assert.match(
    executed[0].auditEventKey,
    /gfe000000000001:recovery-worker-attempt:1$/,
  )
})

test('stale and unresolved claims preserve recovery evidence', async () => {
  const claims = [
    recoveryClaim({
      commerceExportGlobalId: 'gfe000000000002',
      attempt: 4,
      priorState: 'processing',
    }),
    recoveryClaim({
      commerceExportGlobalId: 'gfe000000000003',
      attempt: 5,
      priorState: 'failed',
      priorErrorCode: 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
    }),
  ]
  const executed = []
  const result = await worker.processCommerceFulfillmentRecovery(
    { limit: 2, workerId: 'recovery-worker-test' },
    {
      async finalizeExhausted() {
        return 0
      },
      async claim() {
        return claims.shift() || null
      },
      async execute(input) {
        executed.push(input)
        if (input.preclaimed.priorState === 'processing') {
          return {
            state: 'succeeded',
            errorCode: null,
          }
        }
        return {
          state: 'failed',
          errorCode: 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
        }
      },
    },
  )

  assert.equal(result.recoveryClaims, 2)
  assert.equal(result.succeeded, 1)
  assert.equal(result.unresolved, 1)
  assert.equal(executed[0].preclaimed.priorState, 'processing')
  assert.equal(executed[1].preclaimed.priorState, 'failed')
  assert.equal(
    executed[1].preclaimed.priorErrorCode,
    'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
  )
})

test('claiming is bounded and a concurrent claimant is skipped', async () => {
  const claims = Array.from({ length: 7 }, (_, index) => recoveryClaim({
    commerceExportGlobalId: `gfe00000000000${index + 1}`,
    attempt: index + 1,
  }))
  let executions = 0
  const result = await worker.processCommerceFulfillmentRecovery(
    { limit: 99, workerId: 'recovery-worker-test' },
    {
      async finalizeExhausted() {
        return 0
      },
      async claim() {
        return claims.shift() || null
      },
      async execute() {
        executions += 1
        if (executions === 1) {
          throw codedError('OPERATIONS_COMMERCE_EXPORT_CHANGED')
        }
        return { state: 'succeeded', errorCode: null }
      },
    },
  )

  assert.equal(result.maxClaimsPerInvocation, 5)
  assert.equal(result.claimed, 5)
  assert.equal(result.contentionSkipped, 1)
  assert.equal(result.succeeded, 4)
  assert.equal(executions, 5)
  assert.equal(claims.length, 2)
})

test('unexpected execution failure stays recoverable and does not stop the batch', async () => {
  const claims = [
    recoveryClaim({ commerceExportGlobalId: 'gfe000000000010' }),
    recoveryClaim({ commerceExportGlobalId: 'gfe000000000011' }),
  ]
  let executions = 0
  const result = await worker.processCommerceFulfillmentRecovery(
    { limit: 2, workerId: 'recovery-worker-test' },
    {
      async finalizeExhausted() {
        return 0
      },
      async claim() {
        return claims.shift() || null
      },
      async execute() {
        executions += 1
        if (executions === 1) throw new Error('worker process interruption')
        return { state: 'succeeded', errorCode: null }
      },
    },
  )

  assert.equal(result.executionErrors, 1)
  assert.equal(result.succeeded, 1)
})

test('runtime is explicitly opt-in', () => {
  const original = process.env.CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED
  delete process.env.CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED
  assert.equal(worker.commerceFulfillmentRecoveryRuntimeAvailable(), false)
  process.env.CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED = '1'
  assert.equal(worker.commerceFulfillmentRecoveryRuntimeAvailable(), true)
  if (original === undefined) {
    delete process.env.CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED
  } else {
    process.env.CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED = original
  }
})

test('Postgres claim and audited ceiling finalizer are bounded and fenced', async () => {
  const claimCalls = []
  const finalizerCalls = []
  const audits = []
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/commerceFulfillmentRecovery.ts',
    {
      mocks: {
        '@/lib/auditWriter': {
          async recordAuditEvent(input) {
            audits.push(input)
          },
        },
        '@/lib/persistence/postgres': {
          async query(sql, values) {
            claimCalls.push({ sql, values })
            return {
              rows: [{
                organization_id: '11111111-1111-4111-8111-111111111111',
                global_id: 'gfe000000000001',
                actor_email: null,
                provider: 'faire',
                attempts: 3,
                prior_state: 'processing',
                prior_error_code: null,
              }],
            }
          },
          async withTransaction(work) {
            return work({
              async query(sql, values) {
                finalizerCalls.push({ sql, values })
                return {
                  rowCount: 2,
                  rows: [
                    {
                      organization_id:
                        '11111111-1111-4111-8111-111111111111',
                      global_id: 'gfe000000000008',
                      provider: 'faire',
                      attempts: 8,
                      prior_state: 'processing',
                      prior_error_code: null,
                      original_confirmer: 'operator@example.com',
                    },
                    {
                      organization_id:
                        '11111111-1111-4111-8111-111111111111',
                      global_id: 'gfe000000000009',
                      provider: 'faire',
                      attempts: 8,
                      prior_state: 'failed',
                      prior_error_code:
                        'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
                      original_confirmer: 'operator@example.com',
                    },
                  ],
                }
              },
            })
          },
        },
      },
    },
  )

  const claim = await persistence.claimCommerceFulfillmentRecoveryInPostgres({
    workerId: 'recovery-worker-test',
  })
  assert.equal(claim.attempt, 3)
  assert.equal(claim.priorState, 'processing')
  assert.equal(claim.actorEmail, null)
  assert.deepEqual(JSON.parse(JSON.stringify(claimCalls[0].values)), [
    8,
    30,
    300,
  ])
  const sql = claimCalls[0].sql
  assert.match(sql, /attempts < \$1/)
  assert.match(sql, /FOR UPDATE OF fulfillment_export SKIP LOCKED/)
  assert.match(sql, /attempts = candidate\.attempts/)
  assert.match(sql, /state = candidate\.prior_state/)
  assert.match(sql, /interval '30 seconds'/)
  assert.match(sql, /interval '1 minute'/)
  assert.match(sql, /interval '2 minutes'/)
  assert.match(sql, /interval '5 minutes'/)
  assert.match(sql, /interval '15 minutes'/)
  assert.doesNotMatch(sql, /shipment\.confirmed_by IS NOT NULL/)
  assert.match(sql, /provider IN \('shopify', 'faire'\)/)
  assert.doesNotMatch(sql, /state = 'unsupported'/)

  const finalized = await persistence
    .finalizeExhaustedCommerceFulfillmentRecoveriesInPostgres({
      workerId: 'recovery-worker-test',
      limit: 99,
    })
  assert.equal(finalized, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(finalizerCalls[0].values)), [
    8,
    30,
    300,
    5,
    'OPERATIONS_COMMERCE_EXPORT_AUTOMATIC_RECOVERY_EXHAUSTED',
  ])
  const finalizerSql = finalizerCalls[0].sql
  assert.match(finalizerSql, /attempts >= \$1/)
  assert.match(finalizerSql, /state = 'processing'/)
  assert.match(finalizerSql, /state = 'failed'/)
  assert.match(finalizerSql, /FOR UPDATE OF fulfillment_export SKIP LOCKED/)
  assert.match(finalizerSql, /LIMIT \$4/)
  assert.match(finalizerSql, /error_code = \$5/)
  assert.match(finalizerSql, /attempts = candidate\.attempts/)
  assert.match(finalizerSql, /state = candidate\.prior_state/)
  assert.equal(audits.length, 2)
  assert.ok(audits.every((event) => event.actor === 'system'))
  assert.ok(audits.every((event) => event.isSystem === true))
  assert.ok(audits.every((event) => (
    event.payload.managerRecoveryRequired === true
    && event.payload.providerIo === false
  )))
  assert.match(
    audits[0].eventKey,
    /gfe000000000008:automatic-recovery-exhausted:8$/,
  )
})

test('restart policy distinguishes pre-dispatch crashes from durable attempts', () => {
  const base = {
    provider: 'faire',
    priorState: 'processing',
    priorErrorCode: null,
    hasProviderAttempt: false,
    usesSafeShopifyAttemptProtocol: false,
    usesSafeFaireAttemptProtocol: true,
  }
  assert.equal(recoveryPolicy.commerceFulfillmentRecoveryMode(base), 'execute')
  assert.equal(
    recoveryPolicy.commerceFulfillmentRecoveryMode({
      ...base,
      hasProviderAttempt: true,
    }),
    'reconcile_only',
  )
  assert.equal(
    recoveryPolicy.commerceFulfillmentRecoveryMode({
      ...base,
      priorState: 'failed',
      priorErrorCode: 'FAIRE_REQUEST_REJECTED',
      hasProviderAttempt: true,
      providerAttemptState: 'failed',
    }),
    'execute',
    'A known rejection may be resubmitted through the newer-revision guard',
  )
  assert.equal(
    recoveryPolicy.commerceFulfillmentRecoveryMode({
      ...base,
      usesSafeFaireAttemptProtocol: false,
    }),
    'reconcile_only',
  )
  assert.equal(
    recoveryPolicy.commerceFulfillmentRecoveryMode({
      ...base,
      priorState: 'failed',
      priorErrorCode: 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED',
    }),
    'reconcile_only',
  )
})

test('only transient Faire errors consume the automatic GET budget', () => {
  assert.equal(
    recoveryPolicy.faireFulfillmentErrorAllowsAutomaticReconciliation({
      code: 'FAIRE_ACCESS_DENIED',
    }),
    false,
  )
  assert.equal(
    recoveryPolicy.faireFulfillmentErrorAllowsAutomaticReconciliation({
      code: 'FAIRE_FULFILLMENT_PARTIAL_MATCH',
    }),
    false,
  )
  assert.equal(
    recoveryPolicy.faireFulfillmentErrorAllowsAutomaticReconciliation({
      code: 'FAIRE_FULFILLMENT_READ_SCOPE_REQUIRED',
    }),
    false,
  )
  assert.equal(
    recoveryPolicy.faireFulfillmentErrorAllowsAutomaticReconciliation({
      code: 'FAIRE_REQUEST_TIMEOUT',
    }),
    true,
  )
  assert.equal(
    recoveryPolicy.faireFulfillmentErrorAllowsAutomaticReconciliation({
      code: 'FAIRE_PROVIDER_TRANSIENT',
      retryable: true,
    }),
    true,
  )
  assert.equal(
    recoveryPolicy.faireFulfillmentErrorAllowsAutomaticReconciliation(
      new Error('unclassified'),
    ),
    false,
  )
})

test('poller, proxy, route, and runbook expose the bounded worker', () => {
  const migration = read(
    'db/migrations/0229_operations_commerce_fulfillment_recovery.sql',
  )
  assert.match(
    migration,
    /operations_commerce_fulfillment_exports_recovery_idx/,
  )
  assert.match(
    migration,
    /state,[\s\S]+error_code,[\s\S]+updated_at,[\s\S]+attempts,[\s\S]+id/,
  )
  assert.match(migration, /provider IN \('shopify', 'faire'\)/)
  assert.match(migration, /state IN \('processing', 'failed'\)/)
  const poller = read('scripts/pipeline-outbox-poller.mjs')
  assert.match(poller, /COMMERCE_FULFILLMENT_RECOVERY_POLL_MS \|\| 60000/)
  assert.match(
    poller,
    /CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED \|\| '0'/,
  )
  assert.match(
    poller,
    /\/api\/integrations\/commerce\/fulfillment\/process/,
  )
  assert.match(
    read('app_src/proxy.ts'),
    /\/api\/integrations\/commerce\/fulfillment\/process/,
  )
  const route = read(
    'app_src/app/api/integrations/commerce/fulfillment/process/route.ts',
  )
  assert.match(route, /PIPELINE_OUTBOX_WORKER_SECRET/)
  assert.match(route, /commerceFulfillmentRecoveryRuntimeAvailable/)
  assert.match(route, /recordCommerceFulfillmentRecoveryHeartbeatInPostgres/)
  const runbook = read('docs/operations/distributed-operations-runbook.md')
  assert.match(runbook, /Automatic recovery stops after eight claimed attempts/)
  assert.match(runbook, /Faire reconciliation uses provider GETs only/)
})
