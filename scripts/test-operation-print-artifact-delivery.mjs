#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function loadTypeScript(path, mocks, globals = {}) {
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
    Array,
    BigInt,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Number,
    Object,
    Promise,
    RegExp,
    Response,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process,
    setTimeout,
    structuredClone,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function verifyStaticContracts() {
  const printing = read('app_src/lib/operations/printing.ts')
  assert.ok(
    printing.includes("PRINT_PAYLOAD_ENCODINGS = ['utf8', 'base64']"),
    'Print claims must declare their supported payload encodings',
  )
  assert.ok(
    printing.includes('encoding: PrintPayloadEncoding | null'),
    'Print-claim documents must expose an explicit encoding field',
  )

  const persistence = read('app_src/lib/persistence/operationPrintDelivery.ts')
  for (const fragment of [
    'readOperationsPrintArtifactPayloadInPostgres',
    'FROM operations_print_artifact_payloads payload',
    'payload.organization_id = $1::uuid',
    'artifact.global_id = $2',
    'payload.payload AS artifact_payload',
    'encoding: \'utf8\'',
    'encoding: \'base64\'',
  ]) {
    assert.ok(
      persistence.includes(fragment),
      `Missing artifact persistence contract: ${fragment}`,
    )
  }

  const route = read('app_src/app/api/operations/artifacts/[globalId]/route.ts')
  for (const fragment of [
    'requireRequestUser',
    'activeOperationsOrganizationId',
    'operationsCapabilities(actor).canView',
    'Content-Disposition',
    'private, max-age=31536000, immutable',
    'X-Content-Type-Options',
    'new Uint8Array(artifact.payload)',
  ]) {
    assert.ok(route.includes(fragment), `Missing artifact route contract: ${fragment}`)
  }
}

function verifyOwnedTypeContracts() {
  const configPath = resolve(root, 'app_src', 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined, 'Unable to read app TypeScript configuration')
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(root, 'app_src'),
    { incremental: false, noEmit: true },
    configPath,
  )
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  })
  const ownedSuffixes = [
    '/app_src/lib/operations/printing.ts',
    '/app_src/lib/persistence/operationPrintDelivery.ts',
    '/app_src/app/api/operations/artifacts/[globalId]/route.ts',
  ]
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => (
    diagnostic.file
    && ownedSuffixes.some((suffix) => diagnostic.file.fileName.endsWith(suffix))
  ))
  assert.equal(
    diagnostics.length,
    0,
    diagnostics.map((diagnostic) => (
      `${diagnostic.file?.fileName}: ${
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      }`
    )).join('\n'),
  )
}

async function verifyPersistenceContracts() {
  const pdf = Buffer.from('%PDF-1.4\nartifact delivery\n%%EOF\n', 'ascii')
  const contentSha256 = createHash('sha256').update(pdf).digest('hex')
  const queries = []
  let rows = [{
    global_id: 'gpf1000001',
    content_sha256: contentSha256,
    byte_length: String(pdf.byteLength),
    mime_type: 'application/pdf',
    filename: 'ORDER-100-packing-slip.pdf',
    payload: pdf,
    template_version: 'packing-slip-letter-v1',
    created_at: new Date('2026-07-23T12:00:00.000Z'),
  }]
  const persistence = loadTypeScript(
    'app_src/lib/persistence/operationPrintDelivery.ts',
    {
      crypto: requireFromApp('crypto'),
      '@/lib/auditWriter': { recordAuditEvent: async () => undefined },
      '@/lib/operations/printing': {},
      '@/lib/persistence/operationPrinting': {},
      '@/lib/persistence/operations': { OperationsRequestError: RequestError },
      '@/lib/persistence/postgres': {
        acquireTransactionAdvisoryLock: async () => undefined,
        async query(sql, params) {
          queries.push({ sql, params })
          return { rows }
        },
        withTransaction: async (work) => work({ query: async () => ({ rows: [] }) }),
      },
    },
  )

  const labelPayload = '^XA\n^FO20,20^FDLabel^FS\n^XZ'
  const labelClaim = persistence.encodeOperationsPrintClaimPayload({
    labelPayload,
    artifactPayload: null,
  })
  assert.equal(
    labelClaim.inlinePayload,
    labelPayload,
    'UTF-8 label payloads must remain byte-for-byte unchanged',
  )
  assert.equal(labelClaim.encoding, 'utf8')

  const artifactClaim = persistence.encodeOperationsPrintClaimPayload({
    labelPayload: null,
    artifactPayload: pdf,
  })
  assert.equal(
    artifactClaim.inlinePayload,
    pdf.toString('base64'),
    'Binary artifacts must be base64 encoded for JSON claims',
  )
  assert.equal(artifactClaim.encoding, 'base64')

  const referenceClaim = persistence.encodeOperationsPrintClaimPayload({
    labelPayload: null,
    artifactPayload: null,
  })
  assert.equal(referenceClaim.inlinePayload, null)
  assert.equal(
    referenceClaim.encoding,
    null,
    'Legacy external artifact references must remain representable',
  )

  const artifact = await persistence.readOperationsPrintArtifactPayloadInPostgres({
    organizationId: '11111111-1111-4111-8111-111111111111',
    artifactGlobalId: 'GPF1000001',
  })
  assert.equal(artifact.globalId, 'gpf1000001')
  assert.deepEqual(Buffer.from(artifact.payload), pdf)
  assert.equal(queries.length, 1)
  assert.deepEqual(
    Array.from(queries[0].params),
    ['11111111-1111-4111-8111-111111111111', 'gpf1000001'],
  )
  assert.match(
    queries[0].sql,
    /payload\.organization_id = \$1::uuid[\s\S]+artifact\.global_id = \$2/,
    'Artifact lookup must scope by organization before Global ID',
  )

  await assert.rejects(
    persistence.readOperationsPrintArtifactPayloadInPostgres({
      organizationId: '11111111-1111-4111-8111-111111111111',
      artifactGlobalId: 'gpf-not-valid',
    }),
    (error) => error.code === 'OPERATIONS_PRINT_ARTIFACT_NOT_FOUND' && error.status === 404,
  )
  assert.equal(queries.length, 1, 'Invalid artifact IDs must not query PostgreSQL')

  rows = [{
    ...rows[0],
    payload: Buffer.from('corrupt'),
  }]
  await assert.rejects(
    persistence.readOperationsPrintArtifactPayloadInPostgres({
      organizationId: '11111111-1111-4111-8111-111111111111',
      artifactGlobalId: 'gpf1000001',
    }),
    (error) => error.code === 'OPERATIONS_PRINT_ARTIFACT_CORRUPT' && error.status === 500,
  )
}

class TestNextResponse extends Response {
  static json(value, init = {}) {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    return new TestNextResponse(JSON.stringify(value), { ...init, headers })
  }
}

async function verifyRouteContracts() {
  const pdf = Buffer.from('%PDF-1.4\nroute delivery\n%%EOF\n', 'ascii')
  const contentSha256 = createHash('sha256').update(pdf).digest('hex')
  let authenticated = true
  let canView = true
  const reads = []
  const route = loadTypeScript(
    'app_src/app/api/operations/artifacts/[globalId]/route.ts',
    {
      'next/server': { NextRequest: class {}, NextResponse: TestNextResponse },
      '@/lib/operations/authorization': {
        activeOperationsOrganizationId(actor) {
          if (!actor.organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
          return actor.organizationId
        },
        operationsCapabilities: () => ({ canView }),
      },
      '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
      '@/lib/persistence/operationPrintDelivery': {
        async readOperationsPrintArtifactPayloadInPostgres(input) {
          reads.push(input)
          return {
            globalId: 'gpf1000002',
            contentSha256,
            byteLength: pdf.byteLength,
            mimeType: 'application/pdf',
            filename: '../../Order 100 "packing slip".pdf',
            payload: pdf,
            templateVersion: 'packing-slip-letter-v1',
            createdAt: '2026-07-23T12:00:00.000Z',
          }
        },
      },
      '@/lib/persistence/operations': { OperationsRequestError: RequestError },
      '@/lib/requestUser': {
        async requireRequestUser() {
          if (!authenticated) throw new Error('Unauthorized')
          return {
            email: 'operator@example.com',
            organizationId: '22222222-2222-4222-8222-222222222222',
          }
        },
      },
    },
  )

  const response = await route.GET(
    { headers: new Headers() },
    { params: Promise.resolve({ globalId: 'gpf1000002' }) },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('content-length'), String(pdf.byteLength))
  assert.equal(response.headers.get('etag'), `"${contentSha256}"`)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), 'sandbox')
  assert.match(response.headers.get('cache-control'), /\bprivate\b/)
  assert.match(response.headers.get('cache-control'), /\bimmutable\b/)
  const disposition = response.headers.get('content-disposition')
  assert.match(disposition, /^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/)
  assert.doesNotMatch(disposition, /[\/\\\r\n]/)
  assert.deepEqual({ ...reads[0] }, {
    organizationId: '22222222-2222-4222-8222-222222222222',
    artifactGlobalId: 'gpf1000002',
  })

  const notModified = await route.GET(
    { headers: new Headers({ 'If-None-Match': `"${contentSha256}"` }) },
    { params: Promise.resolve({ globalId: 'gpf1000002' }) },
  )
  assert.equal(notModified.status, 304)
  assert.equal(await notModified.text(), '')

  authenticated = false
  const readCount = reads.length
  const unauthorized = await route.GET(
    { headers: new Headers() },
    { params: Promise.resolve({ globalId: 'gpf1000002' }) },
  )
  assert.equal(unauthorized.status, 401)
  assert.equal(reads.length, readCount, 'Unauthenticated requests must not resolve artifacts')

  authenticated = true
  canView = false
  const forbidden = await route.GET(
    { headers: new Headers() },
    { params: Promise.resolve({ globalId: 'gpf1000002' }) },
  )
  assert.equal(forbidden.status, 403)
  assert.equal(reads.length, readCount, 'Unauthorized operators must not resolve artifacts')
}

verifyStaticContracts()
verifyOwnedTypeContracts()
await verifyPersistenceContracts()
await verifyRouteContracts()
console.log('PASS test-operation-print-artifact-delivery')
