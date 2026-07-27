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
    'FROM operations_print_artifacts artifact',
    'artifact.organization_id = $1::uuid',
    'artifact.global_id = $2',
    'source_label.label_payload AS source_label_payload',
    'rate_test_label.label_payload AS rate_test_label_payload',
    'payload.payload AS artifact_payload',
    "artifact.document_type !== 'packing_slip'",
    "artifact.document_type !== 'shipping_label'",
    "'application/vnd.zebra-zpl'",
    "encoding: format === 'ZPL' ? 'utf8' : 'base64'",
    "encoding: input.format === 'ZPL' ? 'utf8' : 'base64'",
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
    'private, no-cache, max-age=0, must-revalidate',
    'Cross-Origin-Resource-Policy',
    'X-Content-Type-Options',
    'X-ClawPilot-Content-SHA256',
    "ZPL: 'zpl'",
    "PDF: 'pdf'",
    "PNG: 'png'",
    'new Uint8Array(artifact.payload)',
  ]) {
    assert.ok(route.includes(fragment), `Missing artifact route contract: ${fragment}`)
  }
  assert.ok(
    !route.includes('max-age=31536000') && !route.includes('immutable'),
    'Sensitive artifact bytes must never remain fresh in a long-lived browser cache',
  )

  const printJobs = read('app_src/components/operations/PrinterConfigurationPanel.tsx')
  for (const fragment of [
    'Download {selectedJob.format || \'artifact\'}',
    '/api/operations/artifacts/${encodeURIComponent(selectedJob.artifactGlobalId)}',
  ]) {
    assert.ok(printJobs.includes(fragment), `Missing print-job download control: ${fragment}`)
  }

  const rateTestLabels = read('app_src/lib/persistence/carrierRateTestLabels.ts')
  for (const fragment of [
    'printArtifactGlobalId: string | null',
    'print_artifact.global_id AS print_artifact_global_id',
    'printArtifactGlobalId: row.print_artifact_global_id',
  ]) {
    assert.ok(
      rateTestLabels.includes(fragment),
      `Missing diagnostic-label artifact projection: ${fragment}`,
    )
  }

  const carrierPanel = read('app_src/components/settings/CarrierIntegrationPanel.tsx')
  for (const fragment of [
    'selectedRateTestLabel.printArtifactGlobalId',
    'Download stored {selectedRateTestLabel.format}',
  ]) {
    assert.ok(
      carrierPanel.includes(fragment),
      `Missing diagnostic-label download control: ${fragment}`,
    )
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
    document_type: 'packing_slip',
    format: 'PDF',
    media_size: 'letter',
    content_sha256: contentSha256,
    byte_length: String(pdf.byteLength),
    payload_mime_type: 'application/pdf',
    payload_filename: 'ORDER-100-packing-slip.pdf',
    artifact_payload: pdf,
    template_version: 'packing-slip-letter-v1',
    source_label_global_id: null,
    source_label_format: null,
    source_label_payload: null,
    rate_test_label_global_id: null,
    rate_test_label_format: null,
    rate_test_label_payload: null,
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
  assert.equal(artifact.documentType, 'packing_slip')
  assert.equal(artifact.format, 'PDF')
  assert.equal(artifact.media, 'letter')
  assert.equal(artifact.mimeType, 'application/pdf')
  assert.equal(artifact.filename, 'ORDER-100-packing-slip.pdf')
  assert.equal(queries.length, 1)
  assert.deepEqual(
    Array.from(queries[0].params),
    ['11111111-1111-4111-8111-111111111111', 'gpf1000001'],
  )
  assert.match(
    queries[0].sql,
    /artifact\.organization_id = \$1::uuid[\s\S]+artifact\.global_id = \$2/,
    'Artifact lookup must scope by organization before Global ID',
  )

  const zpl = Buffer.from('^XA\n^FO20,20^FDExact ZPL^FS\n^XZ', 'utf8')
  rows = [{
    ...rows[0],
    document_type: 'shipping_label',
    format: 'ZPL',
    media_size: 'label_4x6',
    content_sha256: createHash('sha256').update(zpl).digest('hex'),
    byte_length: String(zpl.byteLength),
    payload_mime_type: null,
    payload_filename: null,
    artifact_payload: null,
    template_version: null,
    rate_test_label_global_id: 'gsl1000001',
    rate_test_label_format: 'ZPL',
    rate_test_label_payload: zpl,
  }]
  const zplArtifact = await persistence.readOperationsPrintArtifactPayloadInPostgres({
    organizationId: '11111111-1111-4111-8111-111111111111',
    artifactGlobalId: 'gpf1000001',
  })
  assert.deepEqual(Buffer.from(zplArtifact.payload), zpl)
  assert.equal(zplArtifact.mimeType, 'application/vnd.zebra-zpl')
  assert.equal(zplArtifact.filename, 'shipping-label-gsl1000001')

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('exact-png-bytes', 'ascii'),
  ])
  rows = [{
    ...rows[0],
    format: 'PNG',
    content_sha256: createHash('sha256').update(png).digest('hex'),
    byte_length: String(png.byteLength),
    source_label_global_id: 'glb1000001',
    source_label_format: 'PNG',
    source_label_payload: png.toString('base64'),
    rate_test_label_global_id: null,
    rate_test_label_format: null,
    rate_test_label_payload: null,
  }]
  const pngArtifact = await persistence.readOperationsPrintArtifactPayloadInPostgres({
    organizationId: '11111111-1111-4111-8111-111111111111',
    artifactGlobalId: 'gpf1000001',
  })
  assert.deepEqual(Buffer.from(pngArtifact.payload), png)
  assert.equal(pngArtifact.mimeType, 'image/png')
  assert.equal(pngArtifact.filename, 'shipping-label-glb1000001')

  const pngRow = rows[0]
  rows = [{ ...pngRow, document_type: 'customs_document' }]
  await assert.rejects(
    persistence.readOperationsPrintArtifactPayloadInPostgres({
      organizationId: '11111111-1111-4111-8111-111111111111',
      artifactGlobalId: 'gpf1000001',
    }),
    (error) => error.code === 'OPERATIONS_PRINT_ARTIFACT_CORRUPT' && error.status === 500,
    'Only packing slips and shipping labels may use the artifact download route',
  )

  await assert.rejects(
    persistence.readOperationsPrintArtifactPayloadInPostgres({
      organizationId: '11111111-1111-4111-8111-111111111111',
      artifactGlobalId: 'gpf-not-valid',
    }),
    (error) => error.code === 'OPERATIONS_PRINT_ARTIFACT_NOT_FOUND' && error.status === 404,
  )
  assert.equal(queries.length, 4, 'Invalid artifact IDs must not query PostgreSQL')

  rows = [{
    ...pngRow,
    content_sha256: '0'.repeat(64),
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
  let actorOrganizationId = '22222222-2222-4222-8222-222222222222'
  const reads = []
  let routeArtifact = {
    globalId: 'gpf1000002',
    documentType: 'packing_slip',
    format: 'PDF',
    media: 'letter',
    contentSha256,
    byteLength: pdf.byteLength,
    mimeType: 'application/pdf',
    filename: '../../Order 100 "packing slip".pdf',
    payload: pdf,
    templateVersion: 'packing-slip-letter-v1',
    createdAt: '2026-07-23T12:00:00.000Z',
  }
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
          return routeArtifact
        },
      },
      '@/lib/persistence/operations': { OperationsRequestError: RequestError },
      '@/lib/requestUser': {
        async requireRequestUser() {
          if (!authenticated) throw new Error('Unauthorized')
          return {
            email: 'operator@example.com',
            organizationId: actorOrganizationId,
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
  assert.equal(response.headers.get('x-clawpilot-content-sha256'), contentSha256)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(response.headers.get('content-security-policy'), 'sandbox')
  assert.equal(
    response.headers.get('cache-control'),
    'private, no-cache, max-age=0, must-revalidate',
  )
  const disposition = response.headers.get('content-disposition')
  assert.match(disposition, /^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/)
  assert.doesNotMatch(disposition, /[\/\\\r\n]/)
  assert.deepEqual({ ...reads[0] }, {
    organizationId: '22222222-2222-4222-8222-222222222222',
    artifactGlobalId: 'gpf1000002',
  })

  const zpl = Buffer.from('^XA\n^FO10,10^FDDownload^FS\n^XZ', 'utf8')
  const zplSha256 = createHash('sha256').update(zpl).digest('hex')
  routeArtifact = {
    ...routeArtifact,
    documentType: 'shipping_label',
    format: 'ZPL',
    media: 'label_4x6',
    contentSha256: zplSha256,
    byteLength: zpl.byteLength,
    mimeType: 'application/vnd.zebra-zpl',
    filename: '../FedEx label.pdf',
    payload: zpl,
    templateVersion: null,
  }
  const zplResponse = await route.GET(
    { headers: new Headers() },
    { params: Promise.resolve({ globalId: 'gpf1000002' }) },
  )
  assert.equal(zplResponse.status, 200)
  assert.deepEqual(Buffer.from(await zplResponse.arrayBuffer()), zpl)
  assert.equal(zplResponse.headers.get('content-type'), 'application/vnd.zebra-zpl')
  assert.equal(
    zplResponse.headers.get('content-disposition'),
    'attachment; filename="FedEx-label.zpl"',
  )

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('route-png', 'ascii'),
  ])
  const pngSha256 = createHash('sha256').update(png).digest('hex')
  routeArtifact = {
    ...routeArtifact,
    format: 'PNG',
    contentSha256: pngSha256,
    byteLength: png.byteLength,
    mimeType: 'image/png',
    filename: 'UPS label.zpl',
    payload: png,
  }
  const pngResponse = await route.GET(
    { headers: new Headers() },
    { params: Promise.resolve({ globalId: 'gpf1000002' }) },
  )
  assert.equal(pngResponse.status, 200)
  assert.deepEqual(Buffer.from(await pngResponse.arrayBuffer()), png)
  assert.equal(pngResponse.headers.get('content-type'), 'image/png')
  assert.equal(
    pngResponse.headers.get('content-disposition'),
    'attachment; filename="UPS-label.png"',
  )

  routeArtifact = {
    ...routeArtifact,
    documentType: 'packing_slip',
    format: 'PDF',
    media: 'letter',
    contentSha256,
    byteLength: pdf.byteLength,
    mimeType: 'application/pdf',
    filename: 'packing-slip.pdf',
    payload: pdf,
    templateVersion: 'packing-slip-letter-v1',
  }
  const readsBeforeRevalidation = reads.length
  const notModified = await route.GET(
    { headers: new Headers({ 'If-None-Match': `"${contentSha256}"` }) },
    { params: Promise.resolve({ globalId: 'gpf1000002' }) },
  )
  assert.equal(notModified.status, 304)
  assert.equal(await notModified.text(), '')
  assert.equal(
    reads.length,
    readsBeforeRevalidation + 1,
    'ETag revalidation must repeat tenant authorization and artifact resolution',
  )

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

  canView = true
  actorOrganizationId = ''
  const organizationRequired = await route.GET(
    { headers: new Headers() },
    { params: Promise.resolve({ globalId: 'gpf1000002' }) },
  )
  assert.equal(organizationRequired.status, 409)
  assert.equal(
    reads.length,
    readCount,
    'Requests without an active organization must not resolve artifacts',
  )
}

verifyStaticContracts()
verifyOwnedTypeContracts()
await verifyPersistenceContracts()
await verifyRouteContracts()
console.log('PASS test-operation-print-artifact-delivery')
