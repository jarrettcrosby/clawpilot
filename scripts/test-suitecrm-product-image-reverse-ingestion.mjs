#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    AbortSignal,
    Array,
    Buffer,
    Date,
    Error,
    FormData,
    Headers,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Response,
    Set,
    String,
    URL,
    URLSearchParams,
    Uint8Array,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0226_suitecrm_product_image_reverse_ingestion.sql',
)
for (const contract of [
  "'suitecrm_import'",
  'crm_suitecrm_product_image_observations',
  'crm_suitecrm_product_image_snapshot_fences',
  'crm_suitecrm_product_image_asset_provenance',
  'crm_suitecrm_product_image_ingestion_worker_heartbeat',
  'SuiteCRM Product image observations are immutable',
  'SuiteCRM Product image provenance is immutable',
  'SuiteCRM Product image snapshot fence cannot regress',
  'SuiteCRM Product image timestamp cannot identify different evidence',
  'SuiteCRM Product image snapshot fence must begin at revision one',
  'crm_suitecrm_product_image_snapshot_fence_provenance_fkey',
  'crm_suitecrm_product_image_observation_provider_writes_zero',
  'crm_suitecrm_product_image_observation_timestamp_valid',
  'crm_suitecrm_product_image_provenance_provider_writes_zero',
  'does not match its observation lineage',
  'result evidence is not exact',
  'provider_write_count integer NOT NULL DEFAULT 0',
  'CHECK (provider_write_count = 0)',
  "correlation_state IN ('exact', 'identity_conflict')",
  "'echo_suppressed'",
  "'media_integrity_conflict'",
  "'imported_secondary'",
]) {
  assert.ok(migration.includes(contract), `migration must include ${contract}`)
}

const persistence = read(
  'app_src/lib/persistence/suiteCrmProductImageIngestion.ts',
)
for (const contract of [
  'product.suitecrm_id = $2',
  'product.reference_code = $3',
  'candidates.rows.length === 1',
  "currentPrimary.source === 'suitecrm_import'",
  'deterministicClawPilotContentHash',
  'SUITECRM_PRODUCT_IMAGE_SNAPSHOT_CONFLICT',
  'SUITECRM_PRODUCT_IMAGE_ACTOR_FORBIDDEN',
  'SUITECRM_PRODUCT_IMAGE_MODIFIED_AT_FUTURE',
  'removedSuiteCrmImportedPrimary',
  "'local_primary_has_independent_authority'",
  "'clawpilot_filename_content_mismatch'",
  "'suitecrm_import'",
  'providerWrites: 0',
]) {
  assert.ok(persistence.includes(contract), `persistence must include ${contract}`)
}
assert.doesNotMatch(persistence, /INSERT INTO sync_outbox/iu)
assert.doesNotMatch(persistence, /commerce_external_effect/iu)
assert.doesNotMatch(persistence, /provider_attempt/iu)
assert.doesNotMatch(persistence, /\bfetch\s*\(/u)

const worker = read('app_src/lib/crm/suiteCrmProductImageIngestion.ts')
for (const contract of [
  'crm.suitecrm.product_image_ingestion.cursor',
  'findSuiteCrmProductImageTargetInPostgres',
  'processSuiteCrmProductImageIngestion',
  'providerWrites: 0',
  "const FULL_HISTORY_START = '1970-01-01T00:00:00.000Z'",
  'const SWEEP_PAGE_SIZES = [37, 53, 71]',
  'pg_try_advisory_lock',
  'pg_advisory_unlock',
  'updatedBeforeOrAt: state.pollStartedAt',
  'reportedTotalRecords',
  "phase: 'discover'",
  "phase: 'verify'",
  'duplicateIdsDetected',
  'membershipChangesDetected',
  'product.modifiedAt',
  'refreshProgressHeartbeat',
]) {
  assert.ok(worker.includes(contract), `worker must include ${contract}`)
}
assert.doesNotMatch(worker, /INITIAL_LOOKBACK_MS|24 \* 60 \* 60/iu)
assert.doesNotMatch(worker, /sync_outbox/iu)
assert.doesNotMatch(worker, /commerce_external_effect/iu)

const readClientSource = read(
  'app_src/lib/crm/suiteCrmProductImageReadClient.ts',
)
for (const contract of [
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION',
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_USERNAME',
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID',
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME',
  'credentialConflicts',
  "'filter[date_modified][lte]'",
  "sort: 'date_modified'",
  "(meta as JsonObject)['total-records']",
  'SuiteCRM Product image changed during the read',
  'content.pathname !== `/api/private-image-media-objects/${mediaId}`',
]) {
  assert.ok(readClientSource.includes(contract), `reader must include ${contract}`)
}
assert.doesNotMatch(readClientSource, /sort:\s*['"]date_modified,id/iu)

const processRoute = read('app_src/app/api/crm/integrations/process/route.ts')
assert.ok(processRoute.includes('processSuiteCrmProductImageIngestion'))
assert.ok(processRoute.includes('suiteCrmProductImageIngestion'))

const healthRoute = read('app_src/app/api/health/route.ts')
assert.ok(healthRoute.includes('suitecrm_product_image_reverse_ingestion_applied'))
assert.ok(healthRoute.includes('suiteCrmProductImageIngestion'))
assert.ok(healthRoute.includes('providerWrites: imageIngestion.providerWrites'))
for (const contract of [
  'guard_crm_suitecrm_product_image_snapshot_fence_write',
  'guard_crm_suitecrm_image_fence_initial_revision_write',
  'crm_suitecrm_product_image_observation_provider_writes_zero',
  'crm_suitecrm_product_image_observation_timestamp_valid',
  'crm_suitecrm_product_image_provenance_provider_writes_zero',
  'crm_suitecrm_product_image_snapshot_fence_provenance_fkey',
  "trigger_row.tgenabled = 'O'",
  'trigger_row.tgfoid = to_regprocedure',
  'trigger_row.tgtype = 31',
  'currentPass: imageIngestion.heartbeat?.details',
  'invalid: suiteCrmProductImageConfiguration.invalid',
  'suiteCrmProductImageConfiguration.credentialConflicts',
  'aclAttestation: suiteCrmProductImageConfiguration.aclAttestation',
]) {
  assert.ok(healthRoute.includes(contract), `health must include ${contract}`)
}
assert.doesNotMatch(
  healthRoute,
  /imageIngestionDegraded[\s\S]{0,300}identityConflicts\s*>\s*0/u,
)

process.env.SUITECRM_BASE_URL = 'https://suitecrm.example.test'
process.env.SUITECRM_PRODUCT_IMAGE_REVERSE_INGESTION_ENABLED = '1'
process.env.SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID = 'read-client-id'
process.env.SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET = 'read-client-secret'
process.env.SUITECRM_PRODUCT_IMAGE_READ_USERNAME = 'clawpilot-image-reader'
process.env.SUITECRM_PRODUCT_IMAGE_READ_PASSWORD = 'read-password'
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED = '1'
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION =
  'suitecrm-product-image-read-acl-v2'
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_USERNAME =
  'clawpilot-image-reader'
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID =
  'read-client-id'
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME =
  'clawpilot-image-reader'
for (const name of [
  'SUITECRM_CLIENT_ID',
  'SUITECRM_CLIENT_SECRET',
  'SUITECRM_ADMIN_USER',
  'SUITECRM_ADMIN_USERNAME',
  'SUITECRM_ADMIN_PASSWORD',
  'SUITECRM_MEDIA_USERNAME',
  'SUITECRM_MEDIA_PASSWORD',
]) delete process.env[name]

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))
const IMAGE_SHA256 = createHash('sha256').update(ONE_PIXEL_PNG).digest('hex')
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
const MEDIA_ID = '22222222-2222-4222-8222-222222222222'
const PRODUCT_GLOBAL_ID = 'gp0123456'
const calls = []
let graphModifiedAt = '2026-08-02T12:00:00Z'
let contentUrlOverride = null
let omitTotalRecords = false

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const fetchImpl = async (input, init = {}) => {
  const url = new URL(String(input))
  const method = String(init.method || 'GET').toUpperCase()
  calls.push({ url, method, init })
  if (url.pathname === '/Api/access_token') {
    const body = JSON.parse(String(init.body || '{}'))
    assert.equal(body.client_id, 'read-client-id')
    assert.equal(body.client_secret, 'read-client-secret')
    return jsonResponse({ access_token: 'read-token', expires_in: 3600 })
  }
  if (url.pathname === '/Api/V8/module/AOS_Products') {
    assert.equal(method, 'GET')
    assert.equal(url.searchParams.get('fields[AOS_Products]'), 'global_id_c,name,date_modified,deleted')
    assert.equal(url.searchParams.get('filter[date_modified][gte]'), '2026-08-02T11:00:00.000Z')
    assert.equal(url.searchParams.get('filter[date_modified][lte]'), '2026-08-02T13:00:00.000Z')
    assert.equal(url.searchParams.get('page[number]'), '1')
    assert.equal(url.searchParams.get('page[size]'), '50')
    assert.equal(url.searchParams.get('sort'), 'date_modified')
    return jsonResponse({
      data: [{
        id: PRODUCT_ID,
        type: 'AOS_Products',
        attributes: {
          global_id_c: PRODUCT_GLOBAL_ID.toUpperCase(),
          name: 'Read-only Product',
          date_modified: '2026-08-02T12:00:00Z',
          deleted: '0',
        },
      }],
      meta: omitTotalRecords
        ? { 'total-pages': 1 }
        : { 'total-pages': 1, 'total-records': 1 },
    })
  }
  if (url.pathname === '/session-status' && calls.filter(
    (call) => call.url.pathname === '/session-status',
  ).length === 1) {
    return jsonResponse({}, 200, {
      'set-cookie': 'XSRF-TOKEN=read-xsrf; Path=/, SCRMSESSID=read-session; Path=/',
    })
  }
  if (url.pathname === '/login') {
    const body = JSON.parse(String(init.body || '{}'))
    assert.deepEqual(body, {
      username: 'clawpilot-image-reader',
      password: 'read-password',
    })
    return jsonResponse({ login_success: 'true' })
  }
  if (url.pathname === '/session-status') return jsonResponse({ active: true })
  if (url.pathname === '/api/graphql') {
    const body = JSON.parse(String(init.body || '{}'))
    assert.equal(body.operationName, 'ClawPilotReadProductImage')
    assert.match(body.query, /^query\s/u)
    assert.doesNotMatch(body.query, /\bmutation\b/u)
    assert.deepEqual(body.variables, { module: 'products', record: PRODUCT_ID })
    return jsonResponse({
      data: {
        record: {
          _id: PRODUCT_ID,
          module: 'products',
          attributes: {
            date_modified: graphModifiedAt,
            clawpilot_image_c: {
              id: MEDIA_ID,
              module: 'media-objects',
              attributes: {
                id: MEDIA_ID,
                original_name: `manual-${IMAGE_SHA256}.png`,
                mime_type: 'image/png',
                size: ONE_PIXEL_PNG.byteLength,
                contentUrl: contentUrlOverride
                  || `/api/private-image-media-objects/${MEDIA_ID}`,
              },
            },
          },
        },
      },
    })
  }
  if (url.pathname === `/api/private-image-media-objects/${MEDIA_ID}`) {
    assert.equal(method, 'GET')
    return new Response(ONE_PIXEL_PNG, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(ONE_PIXEL_PNG.byteLength),
      },
    })
  }
  throw new Error(`Unexpected request: ${method} ${url}`)
}

const readClient = loadTypeScriptModule(
  'app_src/lib/crm/suiteCrmProductImageReadClient.ts',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(readClient.suiteCrmProductImageReadConfiguration())),
  {
    enabled: true,
    ready: true,
    missing: [],
    invalid: [],
    credentialConflicts: [],
    credentialSeparationVerified: true,
    aclAttestation: {
      attested: true,
      current: true,
      requiredVersion: 'suitecrm-product-image-read-acl-v2',
      configuredVersion: 'suitecrm-product-image-read-acl-v2',
      principalBound: true,
      clientBound: true,
      oauthPrincipalBound: true,
    },
    acl: {
      module: 'AOS_Products',
      moduleActions: ['list', 'view'],
      field: 'clawpilot_image_c',
      mediaActions: ['view'],
      forbiddenActions: [
        'create', 'edit', 'delete', 'import', 'export', 'mass_update',
      ],
    },
  },
)
const reader = readClient.createSuiteCrmProductImageReadClient(fetchImpl)
assert.deepEqual(
  JSON.parse(JSON.stringify(await reader.listProductsUpdatedSince({
    updatedSince: '2026-08-02T11:00:00Z',
    updatedBeforeOrAt: '2026-08-02T13:00:00Z',
    page: 1,
  }))),
  {
    products: [{
      id: PRODUCT_ID,
      globalId: PRODUCT_GLOBAL_ID,
      name: 'Read-only Product',
      modifiedAt: '2026-08-02T12:00:00.000Z',
      deleted: false,
    }],
    totalPages: 1,
    totalRecords: 1,
  },
)
const media = await reader.readProductImage(
  PRODUCT_ID,
  '2026-08-02T12:00:00Z',
)
assert.equal(media.mediaId, MEDIA_ID)
assert.equal(media.contentSha256, IMAGE_SHA256)
assert.deepEqual(Buffer.from(media.bytes), Buffer.from(ONE_PIXEL_PNG))

graphModifiedAt = '2026-08-02 12:00:15'
const minutePrecisionMedia = await reader.readProductImage(
  PRODUCT_ID,
  '2026-08-02T12:00:00Z',
)
assert.equal(minutePrecisionMedia.mediaId, MEDIA_ID)
assert.equal(minutePrecisionMedia.contentSha256, IMAGE_SHA256)

graphModifiedAt = '2026-08-02 12:01:00'
await assert.rejects(
  reader.readProductImage(PRODUCT_ID, '2026-08-02T12:00:00Z'),
  /changed during the read/u,
)
graphModifiedAt = '2026-08-02T12:00:00Z'
contentUrlOverride = `/api/private-image-media-objects/${MEDIA_ID}/extra`
await assert.rejects(
  reader.readProductImage(PRODUCT_ID, '2026-08-02T12:00:00Z'),
  /unsafe Product image content URL/u,
)
contentUrlOverride = null
omitTotalRecords = true
assert.equal(
  (await reader.listProductsUpdatedSince({
    updatedSince: '2026-08-02T11:00:00Z',
    updatedBeforeOrAt: '2026-08-02T13:00:00Z',
    page: 1,
  })).totalRecords,
  1,
)
omitTotalRecords = false

const multiPageCalls = []
const multiPageFetch = async (input, init = {}) => {
  const url = new URL(String(input))
  multiPageCalls.push(url)
  if (url.pathname === '/Api/access_token') {
    return jsonResponse({ access_token: 'multi-page-read-token', expires_in: 3600 })
  }
  assert.equal(url.pathname, '/Api/V8/module/AOS_Products')
  assert.equal(String(init.method || 'GET').toUpperCase(), 'GET')
  const page = Number(url.searchParams.get('page[number]'))
  const records = page === 1
    ? [
      '31111111-1111-4111-8111-111111111111',
      '32222222-2222-4222-8222-222222222222',
    ]
    : page === 3
      ? ['35555555-5555-4555-8555-555555555555']
      : []
  return jsonResponse({
    data: records.map((id, index) => ({
      id,
      type: 'AOS_Products',
      attributes: {
        global_id_c: '',
        name: `Paged Product ${page}-${index + 1}`,
        date_modified: '2026-08-02T12:00:00Z',
        deleted: '0',
      },
    })),
    meta: {
      'total-pages': 3,
      'records-on-this-page': records.length,
    },
  })
}
const multiPageReader = readClient.createSuiteCrmProductImageReadClient(
  multiPageFetch,
)
const multiPageResult = await multiPageReader.listProductsUpdatedSince({
  updatedSince: '2026-08-02T11:00:00Z',
  updatedBeforeOrAt: '2026-08-02T13:00:00Z',
  page: 1,
  pageSize: 2,
})
assert.equal(multiPageResult.totalPages, 3)
assert.equal(multiPageResult.totalRecords, 5)
assert.deepEqual(
  multiPageCalls
    .filter((url) => url.pathname === '/Api/V8/module/AOS_Products')
    .map((url) => url.searchParams.get('page[number]')),
  ['1', '3'],
)

const postPaths = calls
  .filter((call) => call.method === 'POST')
  .map((call) => call.url.pathname)
assert.equal(postPaths.filter((path) => path === '/Api/access_token').length, 1)
assert.equal(postPaths.filter((path) => path === '/login').length, 1)
assert.equal(postPaths.filter((path) => path === '/api/graphql').length, 4)
assert.equal(postPaths.every((path) => [
  '/Api/access_token', '/login', '/api/graphql',
].includes(path)), true)
assert.equal(calls.some((call) => ['PATCH', 'PUT', 'DELETE'].includes(call.method)), false)
assert.equal(calls.some((call) => (
  call.url.pathname.startsWith('/api/private-image-media-objects')
  && call.method !== 'GET'
)), false)

process.env.SUITECRM_CLIENT_ID = 'read-client-id'
let readiness = readClient.suiteCrmProductImageReadConfiguration()
assert.equal(readiness.ready, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(readiness.credentialConflicts)),
  ['SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID:SUITECRM_CLIENT_ID'],
)
delete process.env.SUITECRM_CLIENT_ID

process.env.SUITECRM_ADMIN_USERNAME = 'CLAWPILOT-IMAGE-READER'
readiness = readClient.suiteCrmProductImageReadConfiguration()
assert.equal(readiness.ready, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(readiness.credentialConflicts)),
  ['SUITECRM_PRODUCT_IMAGE_READ_USERNAME:SUITECRM_ADMIN_USERNAME'],
)
delete process.env.SUITECRM_ADMIN_USERNAME

process.env.SUITECRM_MEDIA_PASSWORD = 'read-password'
readiness = readClient.suiteCrmProductImageReadConfiguration()
assert.equal(readiness.ready, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(readiness.credentialConflicts)),
  ['SUITECRM_PRODUCT_IMAGE_READ_PASSWORD:SUITECRM_MEDIA_PASSWORD'],
)
delete process.env.SUITECRM_MEDIA_PASSWORD

process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION = 'obsolete-v0'
readiness = readClient.suiteCrmProductImageReadConfiguration()
assert.equal(readiness.ready, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(readiness.invalid)),
  ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION'],
)
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION =
  'suitecrm-product-image-read-acl-v2'

process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID =
  'wrong-client-id'
readiness = readClient.suiteCrmProductImageReadConfiguration()
assert.equal(readiness.ready, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(readiness.invalid)),
  ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID'],
)
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID =
  'read-client-id'

process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME =
  'wrong-oauth-user'
readiness = readClient.suiteCrmProductImageReadConfiguration()
assert.equal(readiness.ready, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(readiness.invalid)),
  ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME'],
)
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME =
  'clawpilot-image-reader'

delete process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED
readiness = readClient.suiteCrmProductImageReadConfiguration()
assert.equal(readiness.ready, false)
assert.deepEqual(
  JSON.parse(JSON.stringify(readiness.missing)),
  ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED'],
)
process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED = '1'

process.env.SUITECRM_ADMIN_USERNAME = 'distinct-admin'
process.env.SUITECRM_ADMIN_PASSWORD = 'distinct-admin-password'
process.env.SUITECRM_MEDIA_USERNAME = 'distinct-media'
process.env.SUITECRM_MEDIA_PASSWORD = 'distinct-media-password'
delete process.env.SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID
let missingCredentialFetches = 0
await assert.rejects(
  readClient.createSuiteCrmProductImageReadClient(async () => {
    missingCredentialFetches += 1
    throw new Error('network must not be reached')
  }).listProductsUpdatedSince({
    updatedSince: '2026-08-02T11:00:00Z',
    updatedBeforeOrAt: '2026-08-02T13:00:00Z',
    page: 1,
  }),
  /SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID is not configured safely/u,
)
assert.equal(missingCredentialFetches, 0)

function suiteProduct(index, modifiedAt = '2026-08-02T12:00:00.000Z') {
  return {
    id: `suite-product-${String(index).padStart(5, '0')}`,
    globalId: `gp${String(index).padStart(7, '0')}`,
    name: `Suite Product ${index}`,
    modifiedAt,
    deleted: false,
  }
}

function loadWorkerHarness({ listImpl, lockAvailable = true }) {
  let cursorValue = null
  const sqlCalls = []
  const listCalls = []
  const imageReads = []
  const ingestions = []
  const heartbeats = []
  const releaseErrors = []
  const lockClient = {
    async query(sql, values = []) {
      const statement = String(sql)
      sqlCalls.push({ statement, values })
      if (statement.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: lockAvailable }] }
      }
      if (statement.includes('pg_advisory_unlock')) {
        return { rows: [{ unlocked: true }] }
      }
      if (statement.includes('SELECT value FROM app_settings')) {
        return { rows: cursorValue === null ? [] : [{ value: cursorValue }] }
      }
      if (statement.includes('INSERT INTO app_settings')) {
        cursorValue = JSON.parse(String(values[1]))
        return { rows: [] }
      }
      throw new Error(`Unexpected worker SQL: ${statement}`)
    },
    release(error) {
      releaseErrors.push(error)
    },
  }
  const workerModule = loadTypeScriptModule(
    'app_src/lib/crm/suiteCrmProductImageIngestion.ts',
    {
      '@/lib/crm/suiteCrmProductImageReadClient': {
        suiteCrmProductImageReadConfiguration() {
          return {
            enabled: true,
            ready: true,
            missing: [],
            invalid: [],
            credentialConflicts: [],
            aclAttestation: { current: true },
          }
        },
        createSuiteCrmProductImageReadClient() {
          return {
            async listProductsUpdatedSince(input) {
              listCalls.push({ ...input })
              return listImpl(input)
            },
            async readProductImage(id, expectedModifiedAt) {
              imageReads.push({ id, expectedModifiedAt })
              return null
            },
          }
        },
      },
      '@/lib/persistence/postgres': {
        getPostgresPool() {
          return { connect: async () => lockClient }
        },
      },
      '@/lib/persistence/suiteCrmProductImageIngestion': {
        async findSuiteCrmProductImageTargetInPostgres() {
          return {
            organizationId: '33333333-3333-4333-8333-333333333333',
            actorEmail: 'suitecrm-reader@example.test',
          }
        },
        async ingestSuiteCrmProductImageSnapshotInPostgres(input) {
          ingestions.push(input)
          return { resolution: 'no_image' }
        },
        async writeSuiteCrmProductImageIngestionHeartbeatInPostgres(input) {
          heartbeats.push(input)
        },
      },
    },
  )
  return {
    process: workerModule.processSuiteCrmProductImageIngestion,
    listCalls,
    imageReads,
    ingestions,
    heartbeats,
    sqlCalls,
    releaseErrors,
    cursor: () => cursorValue,
  }
}

const baselineProduct = suiteProduct(1)
const baselineHarness = loadWorkerHarness({
  listImpl: () => ({
    products: [baselineProduct],
    totalPages: 1,
    totalRecords: 1,
  }),
})
const baselineResult = await baselineHarness.process()
assert.equal(baselineResult.baseline, true)
assert.equal(baselineResult.pending, false)
assert.equal(baselineResult.sweepPhase, 'complete')
assert.equal(baselineResult.providerWrites, 0)
assert.deepEqual(
  baselineHarness.listCalls.map((call) => call.pageSize),
  [37, 53],
)
assert.equal(
  baselineHarness.listCalls.every(
    (call) => call.updatedSince === '1970-01-01T00:00:00.000Z',
  ),
  true,
)
assert.equal(
  baselineHarness.listCalls[0].updatedBeforeOrAt,
  baselineHarness.listCalls[1].updatedBeforeOrAt,
)
assert.deepEqual(baselineHarness.imageReads, [{
  id: baselineProduct.id,
  expectedModifiedAt: baselineProduct.modifiedAt,
}])
assert.equal(baselineHarness.ingestions.length, 1)
assert.equal(baselineHarness.cursor().version, 2)
assert.equal(baselineHarness.cursor().baselineComplete, true)
assert.equal(baselineHarness.cursor().state, null)
assert.equal(
  baselineHarness.cursor().lastPolledAt,
  baselineHarness.listCalls[0].updatedBeforeOrAt,
)
assert.equal(
  baselineHarness.sqlCalls.some((call) => (
    call.statement.includes('pg_try_advisory_lock')
  )),
  true,
)
assert.equal(
  baselineHarness.sqlCalls.some((call) => (
    call.statement.includes('pg_advisory_unlock')
  )),
  true,
)
assert.deepEqual(baselineHarness.releaseErrors, [undefined])

const boundedProducts = Array.from({ length: 200 }, (_, index) => (
  suiteProduct(index + 1)
))
const boundedHarness = loadWorkerHarness({
  listImpl({ page, pageSize }) {
    const offset = (page - 1) * pageSize
    return {
      products: boundedProducts.slice(offset, offset + pageSize),
      totalPages: Math.ceil(boundedProducts.length / pageSize),
      totalRecords: boundedProducts.length,
    }
  },
})
const boundedFirst = await boundedHarness.process()
assert.equal(boundedFirst.pending, true)
assert.equal(boundedFirst.pagesPolled, 5)
assert.equal(boundedHarness.cursor().state.phase, 'discover')
assert.equal(boundedHarness.cursor().state.page, 6)
assert.equal(boundedHarness.cursor().state.seen.length, 185)
assert.equal(boundedHarness.cursor().baselineComplete, false)
const boundedSecond = await boundedHarness.process()
assert.equal(boundedSecond.pending, false)
assert.equal(boundedSecond.pagesPolled, 5)
assert.equal(boundedHarness.cursor().baselineComplete, true)
assert.equal(boundedHarness.cursor().state, null)
assert.equal(boundedHarness.imageReads.length, boundedProducts.length)
assert.equal(boundedHarness.ingestions.length, boundedProducts.length)

const duplicateA = suiteProduct(1)
const duplicateB = suiteProduct(2)
const duplicateHarness = loadWorkerHarness({
  listImpl({ page, pageSize }) {
    if (pageSize === 37) {
      return {
        products: [duplicateA],
        totalPages: 2,
        totalRecords: 2,
      }
    }
    return {
      products: [duplicateA, duplicateB],
      totalPages: 1,
      totalRecords: 2,
    }
  },
})
const duplicateFirst = await duplicateHarness.process()
assert.equal(duplicateFirst.pending, true)
assert.equal(duplicateFirst.duplicateIdsDetected, 1)
assert.equal(duplicateHarness.cursor().state.restartCount, 1)
assert.equal(duplicateHarness.cursor().state.pageSizeIndex, 1)
assert.equal(duplicateHarness.cursor().state.seen.length, 0)
assert.equal(duplicateHarness.imageReads.length, 0)
const duplicateSecond = await duplicateHarness.process()
assert.equal(duplicateSecond.pending, false)
assert.deepEqual(
  duplicateHarness.listCalls.map((call) => call.pageSize),
  [37, 37, 53, 71],
)
assert.equal(duplicateHarness.imageReads.length, 2)

const driftA = suiteProduct(1)
const driftB = suiteProduct(2)
let membershipDrifted = false
let baselineFinished = false
const driftHarness = loadWorkerHarness({
  listImpl({ pageSize }) {
    if (baselineFinished) {
      return { products: [], totalPages: 1, totalRecords: 0 }
    }
    if (pageSize === 53) {
      membershipDrifted = true
      return { products: [driftA], totalPages: 1, totalRecords: 1 }
    }
    return {
      products: membershipDrifted ? [driftA] : [driftA, driftB],
      totalPages: 1,
      totalRecords: membershipDrifted ? 1 : 2,
    }
  },
})
const driftFirst = await driftHarness.process()
assert.equal(driftFirst.pending, true)
assert.equal(driftFirst.membershipChangesDetected, 1)
assert.equal(driftHarness.cursor().baselineComplete, false)
assert.equal(driftHarness.cursor().state.pageSizeIndex, 2)
const driftSecond = await driftHarness.process()
assert.equal(driftSecond.pending, false)
assert.equal(driftHarness.cursor().baselineComplete, true)
const completedSnapshotAt = driftHarness.cursor().lastPolledAt
baselineFinished = true
const incrementalStartIndex = driftHarness.listCalls.length
await driftHarness.process()
assert.equal(
  driftHarness.listCalls[incrementalStartIndex].updatedSince,
  new Date(Date.parse(completedSnapshotAt) - 5 * 60 * 1000).toISOString(),
)

const lockedHarness = loadWorkerHarness({
  lockAvailable: false,
  listImpl() {
    throw new Error('reader must not run without the worker lock')
  },
})
const lockedResult = await lockedHarness.process()
assert.equal(lockedResult.pending, true)
assert.equal(lockedHarness.listCalls.length, 0)
assert.equal(lockedHarness.cursor(), null)
assert.deepEqual(lockedHarness.releaseErrors, [undefined])

console.log('SuiteCRM Product image reverse-ingestion contract passed')
