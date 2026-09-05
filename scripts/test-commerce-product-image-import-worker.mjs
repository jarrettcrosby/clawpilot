#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import * as integrationCredentialRuntimeGate from
  '../app_src/lib/integrations/integrationCredentialRuntimeGate.mjs'

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

const unused = async () => {
  throw new Error('Test must inject this dependency')
}
const worker = loadTypeScriptModule(
  'app_src/lib/commerceProductImageImportWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceProviderImageFetch': {
        fetchCommerceProviderImage: unused,
      },
      '@/lib/integrations/commerceProviderImageSource': {
        withCurrentCommerceProviderImageSources: unused,
        selectCommerceProviderImageSource: unused,
      },
      '@/lib/integrations/integrationCredentialRuntimeGate.mjs':
        integrationCredentialRuntimeGate,
      '@/lib/persistence/commerceProductImageImports': {
        assertCommerceProductImageImportClaimCurrentInPostgres: unused,
        claimCommerceProductImageImportJobsInPostgres: unused,
        completeCommerceProductImageImportJobInPostgres: unused,
        failCommerceProductImageImportJobInPostgres: unused,
        parkCommerceProductImageImportForRuntimeMaintenanceInPostgres: unused,
        parkCommerceProductImageImportForStoreSyncPauseInPostgres: unused,
        recordCommerceProductImageImportWorkerHeartbeatInPostgres: unused,
        resolveWaitingCommerceProductImageImportJobsInPostgres: unused,
      },
      '@/lib/persistence/commerceStoreSync': {
        withCommerceStoreSyncProviderReadFenceInPostgres: unused,
      },
    },
  },
)
const imageImportHealth = loadTypeScriptModule(
  'app_src/lib/commerceProductImageImportHealth.ts',
)

const LOCATOR_A = 'a'.repeat(64)
const LOCATOR_B = 'b'.repeat(64)
const SOURCE_SECRET = 'https://provider.invalid/image.png?credential=must-not-leak'
const BYTES = Uint8Array.from([1, 2, 3])

function claim(overrides = {}) {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    jobGlobalId: 'gcij000000000001',
    observationId: '22222222-2222-4222-8222-222222222222',
    observationGlobalId: 'gcio000000000001',
    organizationId: '33333333-3333-4333-8333-333333333333',
    integrationAccountId: '44444444-4444-4444-8444-444444444444',
    accountGlobalId: 'gcia000000000001',
    provider: 'shopify',
    credentialGeneration: 4,
    externalProductId: 'gid://shopify/Product/500',
    providerImageId: 'gid://shopify/MediaImage/600',
    imageIdentitySha256: 'c'.repeat(64),
    locatorSha256: LOCATOR_A,
    sourceHash: 'd'.repeat(64),
    sequence: 0,
    altText: 'Test product',
    expectedPixelWidth: 1,
    expectedPixelHeight: 1,
    pipelineId: '55555555-5555-4555-8555-555555555555',
    productId: '66666666-6666-4666-8666-666666666666',
    productMappingId: '77777777-7777-4777-8777-777777777777',
    mappingCount: 1,
    mappingFingerprintSha256: 'e'.repeat(64),
    attemptCount: 1,
    maxAttempts: 5,
    leaseToken: '88888888-8888-4888-8888-888888888888',
    leaseExpiresAt: '2026-08-01T12:02:00.000Z',
    actorEmail: 'operator@example.com',
    providerReadAuthority: 'automatic',
    ...overrides,
  }
}

function codedError(code, status, message = 'Sanitized provider failure') {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

test('fresh terminal progress is actively draining even while jobs retry', () => {
  const health = imageImportHealth
    .classifyCommerceProductImageImportOperationalHealth({
      deadCount: 0,
      staleLeaseCount: 0,
      overdueCount: 280,
      retryCount: 12,
      heartbeatPhase: 'completed',
      loopReachable: true,
      progressAgeMs: 79,
      maxProgressAgeMs: 90_000,
    })

  assert.equal(health.activelyDraining, true)
  assert.equal(health.stalledOverdue, false)
  assert.equal(
    health.operationalDegraded,
    true,
    'Retries remain an independent operational degradation',
  )
})

test('overdue jobs without recent terminal progress remain stalled', () => {
  const health = imageImportHealth
    .classifyCommerceProductImageImportOperationalHealth({
      deadCount: 0,
      staleLeaseCount: 0,
      overdueCount: 280,
      retryCount: 0,
      heartbeatPhase: 'completed',
      loopReachable: true,
      progressAgeMs: 90_001,
      maxProgressAgeMs: 90_000,
    })

  assert.equal(health.activelyDraining, false)
  assert.equal(health.stalledOverdue, true)
  assert.equal(health.operationalDegraded, true)
})

test('retry-only image work degrades without inventing an overdue stall', () => {
  const health = imageImportHealth
    .classifyCommerceProductImageImportOperationalHealth({
      deadCount: 0,
      staleLeaseCount: 0,
      overdueCount: 0,
      retryCount: 3,
      heartbeatPhase: 'completed',
      loopReachable: true,
      progressAgeMs: null,
      maxProgressAgeMs: 90_000,
    })

  assert.equal(health.activelyDraining, false)
  assert.equal(health.stalledOverdue, false)
  assert.equal(health.operationalDegraded, true)
})

function fixture(input = {}) {
  const claims = [...(input.claims || [claim()])]
  const state = {
    resolve: [],
    claims: [],
    currentChecks: [],
    providerReadFences: [],
    reads: [],
    selections: [],
    fetches: [],
    completions: [],
    failures: [],
    parks: [],
    runtimeChecks: [],
    runtimeParks: [],
    heartbeats: [],
  }
  const sources = input.sources || [{
    providerImageId: 'gid://shopify/MediaImage/600',
    locatorSha256: LOCATOR_A,
    sequence: 0,
    url: SOURCE_SECRET,
  }]
  const dependencies = {
    assertProviderIoReady() {
      state.runtimeChecks.push({ sequence: state.runtimeChecks.length + 1 })
      if (input.runtimeErrorAt === state.runtimeChecks.length) {
        throw input.runtimeError
      }
    },
    async resolveWaiting(args) {
      state.resolve.push(args)
      return input.resolved || []
    },
    async claim(args) {
      state.claims.push(args)
      return claims.length ? [claims.shift()] : []
    },
    async assertCurrent(args) {
      state.currentChecks.push(args)
      if (input.currentError) throw input.currentError
    },
    async withProviderReadFence(args) {
      state.providerReadFences.push({
        organizationId: args.organizationId,
        integrationAccountId: args.integrationAccountId,
      })
      if (input.providerReadFenceError) {
        throw input.providerReadFenceError
      }
      return args.read()
    },
    async withSources(args) {
      state.providerReadFences.push({
        organizationId: args.organizationId,
        accountGlobalId: args.accountGlobalId,
        authorityKind: args.authorityKind,
      })
      if (input.providerReadFenceError) {
        throw input.providerReadFenceError
      }
      state.reads.push(args)
      if (input.readError) throw input.readError
      return args.consume(sources)
    },
    selectSource(args) {
      state.selections.push(args)
      if (input.selectError) throw input.selectError
      return args.sources.find((source) => (
        source.providerImageId === args.providerImageId
        && source.locatorSha256 === args.locatorSha256
      ))
    },
    async fetchImage(args) {
      state.fetches.push(args)
      if (input.fetchError) throw input.fetchError
      return {
        bytes: BYTES,
        byteLength: BYTES.length,
        contentSha256: 'f'.repeat(64),
        mediaType: 'image/png',
        normalizationVersion: 'identity-v1',
        pixelWidth: 1,
        pixelHeight: 1,
        sourceByteLength: BYTES.length,
        sourceContentSha256: 'f'.repeat(64),
      }
    },
    async complete(args) {
      state.completions.push(args)
      if (input.completeError) throw input.completeError
      return { replayed: false }
    },
    async fail(args) {
      state.failures.push(args)
      if (input.failError) throw input.failError
      return {
        state: input.failureState || (args.retryable ? 'retry' : 'dead'),
        attemptCount: 1,
      }
    },
    async park(args) {
      state.parks.push(args)
      if (input.parkError) throw input.parkError
      return { parked: input.parked !== false }
    },
    async parkRuntime(args) {
      state.runtimeParks.push(args)
      if (input.runtimeParkError) throw input.runtimeParkError
      return { parked: input.runtimeParked !== false }
    },
    async heartbeat(args) {
      state.heartbeats.push(args)
      if (input.heartbeatError === args.phase) {
        throw codedError('COMMERCE_PRODUCT_IMAGE_HEARTBEAT_FAILED', 503)
      }
      return { phase: args.phase, checkedAt: '2026-08-01T12:00:00.000Z' }
    },
  }
  return { dependencies, state }
}

test('imports sequential claims and reuses one exact product source read', async () => {
  const second = claim({
    jobId: '99999999-9999-4999-8999-999999999999',
    jobGlobalId: 'gcij000000000002',
    observationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    observationGlobalId: 'gcio000000000002',
    providerImageId: 'gid://shopify/MediaImage/601',
    locatorSha256: LOCATOR_B,
    sequence: 1,
    leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  })
  const run = fixture({
    claims: [claim(), second],
    resolved: [
      { state: 'queued' },
      { state: 'waiting_mapping' },
    ],
    sources: [
      {
        providerImageId: 'gid://shopify/MediaImage/600',
        locatorSha256: LOCATOR_A,
        sequence: 0,
        url: SOURCE_SECRET,
      },
      {
        providerImageId: 'gid://shopify/MediaImage/601',
        locatorSha256: LOCATOR_B,
        sequence: 1,
        url: `${SOURCE_SECRET}&image=2`,
      },
    ],
  })
  const result = await worker.processCommerceProductImageImports(
    { limit: 2, workerId: 'image-worker-test' },
    run.dependencies,
  )

  assert.equal(result.waitingResolved, 1)
  assert.equal(result.claimed, 2)
  assert.equal(result.providerReads, 1)
  assert.equal(result.fetched, 2)
  assert.equal(result.succeeded, 2)
  assert.equal(result.providerWrites, 0)
  assert.equal(run.state.resolve[0].organizationId, undefined)
  assert.equal(run.state.claims.length, 2)
  assert.equal(run.state.runtimeChecks.length, 7)
  assert.ok(run.state.claims.every((entry) => entry.limit === 1))
  assert.ok(run.state.claims.every((entry) => entry.leaseSeconds === 120))
  assert.equal(run.state.completions[0].actorEmail, 'operator@example.com')
  assert.equal(run.state.completions[0].bytes, BYTES)
  assert.equal(run.state.completions[0].sourceByteLength, BYTES.length)
  assert.equal(run.state.completions[0].sourceContentSha256, 'f'.repeat(64))
  assert.equal(run.state.completions[0].normalizationVersion, 'identity-v1')
  assert.equal(run.state.heartbeats.map((entry) => entry.phase).join(','), 'starting,completed')
  assert.ok(!JSON.stringify(result).includes(SOURCE_SECRET))
  assert.ok(!JSON.stringify(result).includes('operator@example.com'))
  assert.ok(!JSON.stringify(result).includes('11111111-1111'))
  assert.ok(!JSON.stringify(result).includes('gcij000000000001'))
})

test('runtime proof outage stops before waiting resolution or claim', async () => {
  const runtimeError =
    new integrationCredentialRuntimeGate.IntegrationCredentialRuntimeGateError(
      'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
    )
  const run = fixture({ runtimeError, runtimeErrorAt: 1 })

  await assert.rejects(
    worker.processCommerceProductImageImports(
      { workerId: 'image-worker-runtime-preflight' },
      run.dependencies,
    ),
    (error) => error === runtimeError,
  )

  assert.equal(run.state.resolve.length, 0)
  assert.equal(run.state.claims.length, 0)
  assert.equal(run.state.runtimeParks.length, 0)
  assert.equal(run.state.failures.length, 0)
  assert.equal(
    run.state.heartbeats.map((entry) => entry.phase).join(','),
    'starting,degraded',
  )
})

test('runtime proof outage after claim parks without retry or dead-letter',
  async () => {
    const runtimeError =
      new integrationCredentialRuntimeGate.IntegrationCredentialRuntimeGateError(
        'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
      )
    const run = fixture({ readError: runtimeError })

    await assert.rejects(
      worker.processCommerceProductImageImports(
        { workerId: 'image-worker-runtime-race' },
        run.dependencies,
      ),
      (error) => error === runtimeError,
    )

    assert.equal(run.state.claims.length, 1)
    assert.equal(run.state.runtimeParks.length, 1)
    assert.equal(
      run.state.runtimeParks[0].errorCode,
      'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
    )
    assert.equal(run.state.failures.length, 0)
    assert.equal(run.state.fetches.length, 0)
    assert.equal(
      run.state.heartbeats.map((entry) => entry.phase).join(','),
      'starting,degraded',
    )
  },
)

test('stale provider source is a permanent persisted failure', async () => {
  const run = fixture({
    selectError: codedError(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_STALE',
      409,
      `Source changed: ${SOURCE_SECRET}`,
    ),
  })
  const result = await worker.processCommerceProductImageImports(
    { workerId: 'image-worker-test' },
    run.dependencies,
  )

  assert.equal(result.dead, 1)
  assert.equal(result.retried, 0)
  assert.equal(run.state.fetches.length, 0)
  assert.equal(run.state.failures[0].retryable, false)
  assert.equal(
    result.errorCodes.COMMERCE_PROVIDER_IMAGE_SOURCE_STALE,
    1,
  )
  assert.ok(!JSON.stringify(result).includes(SOURCE_SECRET))
  assert.equal(run.state.heartbeats.map((entry) => entry.phase).join(','), 'starting,completed')
})

test('Store sync pause after claim stops image provider reads and retries safely',
  async () => {
    const run = fixture({
      currentError: codedError(
        'COMMERCE_PRODUCT_IMAGE_STORE_SYNC_PAUSED',
        409,
        'Store sync paused before provider I/O',
      ),
    })
    const result = await worker.processCommerceProductImageImports(
      { workerId: 'image-worker-paused' },
      run.dependencies,
    )

    assert.equal(run.state.currentChecks.length, 1)
    assert.equal(run.state.reads.length, 0)
    assert.equal(run.state.fetches.length, 0)
    assert.equal(run.state.failures.length, 0)
    assert.equal(run.state.parks.length, 1)
    assert.equal(result.parked, 1)
    assert.equal(
      result.errorCodes.COMMERCE_PRODUCT_IMAGE_STORE_SYNC_PAUSED,
      1,
    )
  },
)

test('committed Store sync Pause blocks the shared source and byte-read fence',
  async () => {
    const run = fixture({
      providerReadFenceError: codedError(
        'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED',
        409,
        'Store sync is Paused for this commerce connection',
      ),
    })
    const result = await worker.processCommerceProductImageImports(
      { workerId: 'image-worker-provider-fence-paused' },
      run.dependencies,
    )

    assert.equal(run.state.currentChecks.length, 1)
    assert.equal(run.state.providerReadFences.length, 1)
    assert.equal(run.state.reads.length, 0)
    assert.equal(run.state.fetches.length, 0)
    assert.equal(run.state.completions.length, 0)
    assert.equal(run.state.failures.length, 0)
    assert.equal(run.state.parks.length, 1)
    assert.equal(result.parked, 1)
    assert.equal(
      result.errorCodes.COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED,
      1,
    )
  },
)

test('mapping drift returns a claimed image to visible waiting-mapping work', async () => {
  const run = fixture({
    selectError: codedError(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_STALE',
      409,
    ),
    failureState: 'waiting_mapping',
  })
  const result = await worker.processCommerceProductImageImports(
    { limit: 1, workerId: 'image-worker-test' },
    run.dependencies,
  )
  assert.equal(result.waitingMapping, 1)
  assert.equal(result.retried, 0)
  assert.equal(result.dead, 0)
  assert.equal(result.cancelled, 0)
  assert.equal(run.state.failures.length, 1)
})

test('transport timeout is retried with a bounded durable delay', async () => {
  const run = fixture({
    fetchError: codedError(
      'COMMERCE_PROVIDER_IMAGE_TIMEOUT',
      504,
      `Timeout while reading ${SOURCE_SECRET}`,
    ),
  })
  const result = await worker.processCommerceProductImageImports(
    { workerId: 'image-worker-test' },
    run.dependencies,
  )

  assert.equal(result.retried, 1)
  assert.equal(result.dead, 0)
  assert.equal(run.state.failures[0].retryable, true)
  assert.equal(run.state.failures[0].retryAfterSeconds, 30)
  assert.equal(result.errorCodes.COMMERCE_PROVIDER_IMAGE_TIMEOUT, 1)
  assert.ok(!JSON.stringify(result).includes(SOURCE_SECRET))
})

test('transient database conflicts use one sanitized retryable code', async () => {
  for (const databaseCode of ['40P01', '40001']) {
    const run = fixture({
      completeError: codedError(databaseCode, undefined, SOURCE_SECRET),
    })
    const result = await worker.processCommerceProductImageImports(
      { workerId: 'image-worker-test' },
      run.dependencies,
    )

    assert.equal(result.retried, 1)
    assert.equal(result.dead, 0)
    assert.equal(run.state.failures[0].retryable, true)
    assert.equal(run.state.failures[0].retryAfterSeconds, 30)
    assert.equal(
      run.state.failures[0].errorCode,
      'COMMERCE_PRODUCT_IMAGE_DATABASE_RETRYABLE',
    )
    assert.equal(
      result.errorCodes.COMMERCE_PRODUCT_IMAGE_DATABASE_RETRYABLE,
      1,
    )
    assert.ok(!JSON.stringify(result).includes(databaseCode))
    assert.ok(!JSON.stringify(result).includes(SOURCE_SECRET))
  }
})

test('invalid image content is permanently dead', async () => {
  const run = fixture({
    fetchError: codedError(
      'COMMERCE_PROVIDER_IMAGE_MIME_MISMATCH',
      415,
    ),
  })
  const result = await worker.processCommerceProductImageImports(
    { workerId: 'image-worker-test' },
    run.dependencies,
  )

  assert.equal(result.dead, 1)
  assert.equal(run.state.failures[0].retryable, false)
})

test('oversized exact fan-out is a permanent visible review failure', async () => {
  const run = fixture({
    completeError: codedError(
      'COMMERCE_PRODUCT_IMAGE_FANOUT_REVIEW_REQUIRED',
      409,
    ),
  })
  const result = await worker.processCommerceProductImageImports(
    { workerId: 'image-worker-test' },
    run.dependencies,
  )

  assert.equal(result.dead, 1)
  assert.equal(result.retried, 0)
  assert.equal(run.state.failures[0].retryable, false)
  assert.equal(
    run.state.failures[0].errorCode,
    'COMMERCE_PRODUCT_IMAGE_FANOUT_REVIEW_REQUIRED',
  )
})

test('lease loss never attempts a second state transition', async () => {
  const run = fixture({
    completeError: codedError(
      'COMMERCE_PRODUCT_IMAGE_LEASE_LOST',
      409,
    ),
  })
  const result = await worker.processCommerceProductImageImports(
    { workerId: 'image-worker-test' },
    run.dependencies,
  )

  assert.equal(result.leaseLost, 1)
  assert.equal(result.succeeded, 0)
  assert.equal(run.state.failures.length, 0)
})

test('failure persistence lease loss is counted without leaking the first error', async () => {
  const run = fixture({
    fetchError: codedError(
      'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED',
      502,
      SOURCE_SECRET,
    ),
    failError: codedError('COMMERCE_PRODUCT_IMAGE_LEASE_LOST', 409),
  })
  const result = await worker.processCommerceProductImageImports(
    { workerId: 'image-worker-test' },
    run.dependencies,
  )

  assert.equal(result.leaseLost, 1)
  assert.equal(result.retried, 0)
  assert.equal(
    result.errorCodes.COMMERCE_PRODUCT_IMAGE_LEASE_LOST,
    1,
  )
  assert.ok(!JSON.stringify(result).includes(SOURCE_SECRET))
})

test('untrusted errors collapse to one sanitized error code', async () => {
  const run = fixture({
    readError: codedError(
      'SHOPIFY_FAKE_SECRET_ABC123',
      400,
      SOURCE_SECRET,
    ),
  })
  const result = await worker.processCommerceProductImageImports(
    { workerId: 'image-worker-test' },
    run.dependencies,
  )

  assert.equal(result.dead, 1)
  assert.equal(
    result.errorCodes.COMMERCE_PRODUCT_IMAGE_IMPORT_FAILED,
    1,
  )
  assert.equal(
    run.state.failures[0].errorCode,
    'COMMERCE_PRODUCT_IMAGE_IMPORT_FAILED',
  )
  assert.ok(!JSON.stringify(result).includes(SOURCE_SECRET))
})

test('top-level failure records a best-effort degraded heartbeat and rethrows', async () => {
  const run = fixture({ heartbeatError: 'degraded' })
  run.dependencies.resolveWaiting = async () => {
    throw codedError('COMMERCE_PRODUCT_IMAGE_QUEUE_FAILED', 503, SOURCE_SECRET)
  }
  await assert.rejects(
    worker.processCommerceProductImageImports(
      { workerId: 'image-worker-test' },
      run.dependencies,
    ),
    (error) => error.code === 'COMMERCE_PRODUCT_IMAGE_QUEUE_FAILED',
  )
  assert.equal(
    run.state.heartbeats.map((entry) => entry.phase).join(','),
    'starting,degraded',
  )
})

test('secret route authorizes in constant time and only returns safe aggregates', async () => {
  const savedSecret = process.env.PIPELINE_OUTBOX_WORKER_SECRET
  process.env.PIPELINE_OUTBOX_WORKER_SECRET = 's'.repeat(40)
  let workerCalls = 0
  let runtimeAvailable = true
  let workerError = null
  const route = loadTypeScriptModule(
    'app_src/app/api/integrations/commerce/images/process/route.ts',
    {
      mocks: {
        'next/server': {
          NextResponse: {
            json(body, init = {}) {
              return {
                body,
                status: init.status || 200,
                headers: init.headers || {},
              }
            },
          },
        },
        '@/lib/commerceProductImageImportWorker': {
          async processCommerceProductImageImports() {
            workerCalls += 1
            if (workerError) throw workerError
            return {
              waitingResolved: 2,
              waitingMapping: 0,
              claimed: 1,
              providerReads: 1,
              fetched: 1,
              succeeded: 1,
              retried: 0,
              dead: 0,
              cancelled: 0,
              leaseLost: 0,
              failed: 0,
              providerWrites: 0,
              errorCodes: {},
            }
          },
        },
        '@/lib/integrations/commerceIntake': {
          commerceReadRuntimeAvailable() {
            return runtimeAvailable
          },
        },
        '@/lib/integrations/integrationCredentialRuntimeGate.mjs':
          integrationCredentialRuntimeGate,
        '@/lib/persistence/config': {
          isPostgresStorageEnabled() {
            return true
          },
        },
      },
    },
  )
  const request = (authorization) => ({
    headers: {
      get(name) {
        return name.toLowerCase() === 'authorization' ? authorization : null
      },
    },
    async json() {
      return { limit: 1 }
    },
  })
  try {
    const denied = await route.POST(request('Bearer wrong'))
    assert.equal(denied.status, 401)
    assert.equal(denied.body.errorCode, 'UNAUTHORIZED')
    assert.equal(workerCalls, 0)

    const allowed = await route.POST(request(`Bearer ${'s'.repeat(40)}`))
    assert.equal(allowed.status, 200)
    assert.equal(allowed.body.claimed, 1)
    assert.equal(allowed.body.providerWrites, 0)
    assert.equal(workerCalls, 1)
    assert.ok(!JSON.stringify(allowed.body).includes(SOURCE_SECRET))

    workerError =
      new integrationCredentialRuntimeGate.IntegrationCredentialRuntimeGateError(
        'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
      )
    const maintenance = await route.POST(
      request(`Bearer ${'s'.repeat(40)}`),
    )
    assert.equal(maintenance.status, 503)
    assert.equal(maintenance.headers['Retry-After'], '60')
    assert.equal(maintenance.body.maintenance, true)
    assert.equal(maintenance.body.retryable, true)
    assert.equal(
      maintenance.body.errorCode,
      'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
    )

    workerError = codedError(
      'UNSAFE_PROVIDER_DETAIL',
      500,
      SOURCE_SECRET,
    )
    const failed = await route.POST(request(`Bearer ${'s'.repeat(40)}`))
    assert.equal(failed.status, 500)
    assert.equal(
      failed.body.errorCode,
      'COMMERCE_PRODUCT_IMAGE_WORKER_FAILED',
    )
    assert.ok(!JSON.stringify(failed.body).includes(SOURCE_SECRET))
    workerError = null

    runtimeAvailable = false
    const disabled = await route.POST(request(`Bearer ${'s'.repeat(40)}`))
    assert.equal(disabled.status, 200)
    assert.equal(disabled.body.skipped, 1)
    assert.equal(
      disabled.body.errorCodes.COMMERCE_PRODUCT_IMAGE_IMPORT_DISABLED,
      1,
    )
    assert.equal(workerCalls, 3)
  } finally {
    if (savedSecret === undefined) {
      delete process.env.PIPELINE_OUTBOX_WORKER_SECRET
    } else {
      process.env.PIPELINE_OUTBOX_WORKER_SECRET = savedSecret
    }
  }
})

test('worker route, proxy, and poller are wired without unsafe output paths', () => {
  const workerSource = read('app_src/lib/commerceProductImageImportWorker.ts')
  const routeSource = read(
    'app_src/app/api/integrations/commerce/images/process/route.ts',
  )
  const persistenceSource = read(
    'app_src/lib/persistence/commerceProductImageImports.ts',
  )
  const proxySource = read('app_src/proxy.ts')
  const pollerSource = read('scripts/pipeline-outbox-poller.mjs')

  for (const fragment of [
    'resolveWaitingCommerceProductImageImportJobsInPostgres',
    'claimCommerceProductImageImportJobsInPostgres',
    'withCurrentCommerceProviderImageSources',
    'selectCommerceProviderImageSource',
    'fetchCommerceProviderImage',
    'completeCommerceProductImageImportJobInPostgres',
    'recordCommerceProductImageImportWorkerHeartbeatInPostgres',
    'assertIntegrationCredentialProviderIoReady',
    'parkCommerceProductImageImportForRuntimeMaintenanceInPostgres',
    'actorEmail: claim.actorEmail',
    'limit: 1',
    'leaseSeconds: JOB_LEASE_SECONDS',
    'providerWrites: 0',
    "heartbeat({ phase: 'starting' })",
    "heartbeat({ phase: 'completed' })",
    "heartbeat({ phase: 'degraded' })",
  ]) assert.ok(workerSource.includes(fragment), `Worker missing ${fragment}`)
  assert.ok(routeSource.includes('PIPELINE_OUTBOX_WORKER_SECRET'))
  assert.ok(routeSource.includes('timingSafeEqual'))
  assert.ok(routeSource.includes('processCommerceProductImageImports'))
  assert.ok(routeSource.includes('errorCode:'))
  assert.ok(!routeSource.includes('error:'))
  assert.ok(routeSource.includes('isIntegrationCredentialRuntimeGateError'))
  assert.ok(routeSource.includes('status: 503'))
  assert.ok(routeSource.includes("'Retry-After': '60'"))
  assert.ok(persistenceSource.includes(
    'parkCommerceProductImageImportForRuntimeMaintenanceInPostgres',
  ))
  assert.ok(persistenceSource.includes(
    'attempt_count = GREATEST(0, attempt_count - 1)',
  ))
  assert.ok(persistenceSource.includes('last_error_code = $6'))
  assert.ok(!workerSource.includes('console.'))
  assert.ok(!workerSource.includes('error.message'))
  assert.ok(!workerSource.includes('String(error)'))
  assert.equal(
    workerSource.match(/selected\.url/g)?.length,
    2,
    'cache-miss and cache-hit byte reads must each use the exact selected locator',
  )
  assert.ok(!workerSource.includes('providerWrites: 1'))
  assert.ok(proxySource.includes('/api/integrations/commerce/images/process'))
  assert.ok(pollerSource.includes('COMMERCE_PRODUCT_IMAGE_IMPORT_POLL_MS'))
  assert.ok(pollerSource.includes(
    "runLoop('commerce-product-images', '/api/integrations/commerce/images/process', 5, commerceProductImageImportIntervalMs)",
  ))
  assert.ok(pollerSource.includes('/api/integrations/commerce/images/process'))
  assert.ok(workerSource.includes('const MAX_JOB_LIMIT = 5'))
  assert.ok(workerSource.includes(
    'const sourceReads = new Map<string, readonly CommerceProviderImageSource[]>()',
  ))
})
