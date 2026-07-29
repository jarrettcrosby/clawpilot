#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  const sandbox = {
    Buffer,
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
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const packingSlip = loadTypeScriptModule(
  'app_src/lib/operations/packingSlip.ts',
)
const artifactModule = loadTypeScriptModule(
  'app_src/lib/persistence/operationsRegressionArtifacts.ts',
  { '@/lib/operations/packingSlip': packingSlip },
)

const queries = []
let storedPayload = null
let storedSnapshot = null
const client = {
  async query(sql, params = []) {
    queries.push(String(sql))
    if (String(sql).includes('INSERT INTO operations_print_artifacts')) {
      return {
        rows: [{
          id: '18a2bc9e-a138-4c74-8b72-30743035816f',
          global_id: 'gpf0000001',
          content_sha256: params[1],
          byte_length: String(params[2]),
        }],
      }
    }
    if (String(sql).includes('INSERT INTO operations_print_artifact_payloads')) {
      storedPayload = Buffer.from(params[4])
      storedSnapshot = JSON.parse(params[6])
      return { rows: [] }
    }
    throw new Error(`Unexpected SQL in artifact test: ${sql}`)
  },
}

const artifact = await artifactModule
  .persistOperationsRegressionPackingSlipArtifactWithClient(client, {
    organizationId: 'a8f9e273-4b39-4b79-90c4-b879749ce342',
    actorEmail: 'operator@example.com',
    runGlobalId: 'gprr0000001',
    scenarioId: 'mixed-case-repack',
    sourceReference: 'shopify-recorded-order-1001',
    orderNumber: 'REPLAY-1001-PACKAGE-1',
    customerName: 'Replay Customer',
    customerGlobalId: 'ga0000001',
    packageKey: 'fulfillment-package-1',
    packageSequence: 1,
    packageCount: 2,
    trackingNumber: '1ZRECORDED000000001',
    carrier: 'ups_rest',
    serviceCode: '03',
    recordedLabelReference: 'recorded-label-fixture-v1-package-1',
    recordedAt: '2026-07-29T14:00:00.000Z',
    shipTo: {
      name: 'Replay Customer',
      line1: '100 Replay Lane',
      city: 'Hartford',
      region: 'CT',
      postalCode: '06103',
      country: 'US',
    },
    lines: [
      {
        lineKey: 'line-2',
        productKey: 'product-2',
        title: 'Two ounce bag',
        quantity: 6,
      },
      {
        lineKey: 'line-1',
        productKey: 'product-1',
        title: 'Six ounce bag',
        quantity: 12,
      },
    ],
  })

assert.equal(artifact.globalId, 'gpf0000001')
assert.equal(
  artifact.contentUrl,
  '/api/operations/artifacts/gpf0000001',
)
assert.ok(storedPayload)
assert.equal(storedPayload.subarray(0, 5).toString('ascii'), '%PDF-')
const pdfSource = storedPayload.toString('binary')
assert.ok(pdfSource.includes('ClawPilot Recorded Replay Packing Slip'))
assert.ok(pdfSource.includes('No carrier call or postage purchase was performed'))
assert.ok(pdfSource.includes('1ZRECORDED000000001'))
assert.ok(pdfSource.includes('Six ounce bag'))
assert.ok(pdfSource.includes('Two ounce bag'))

assert.deepEqual(
  storedSnapshot.lines.map((line) => line.lineKey),
  ['line-1', 'line-2'],
)
assert.equal(storedSnapshot.documentStage, 'recorded_fulfillment_replay')
assert.equal(storedSnapshot.runGlobalId, 'gprr0000001')
assert.equal(storedSnapshot.packageKey, 'fulfillment-package-1')
assert.equal(storedSnapshot.trackingNumber, '1ZRECORDED000000001')
assert.equal(storedSnapshot.providerWriteCount, 0)
assert.equal(storedSnapshot.postagePurchaseCount, 0)

const combinedSql = queries.join('\n')
assert.doesNotMatch(combinedSql, /operations_labels/)
assert.doesNotMatch(combinedSql, /operations_shipments/)
assert.doesNotMatch(combinedSql, /operations_print_jobs/)
assert.equal(
  queries.filter((sql) => sql.includes('operations_print_artifacts')).length,
  1,
)
assert.equal(
  queries.filter(
    (sql) => sql.includes('operations_print_artifact_payloads'),
  ).length,
  1,
)

await assert.rejects(
  artifactModule.persistOperationsRegressionPackingSlipArtifactWithClient(
    { query: async () => {
      throw new Error('SQL should not execute')
    } },
    {
      organizationId: 'a8f9e273-4b39-4b79-90c4-b879749ce342',
      actorEmail: 'operator@example.com',
      runGlobalId: 'gprr0000002',
      scenarioId: 'invalid',
      sourceReference: 'invalid',
      orderNumber: 'INVALID',
      customerName: 'Replay Customer',
      customerGlobalId: 'ga0000001',
      packageKey: 'package-1',
      packageSequence: 1,
      packageCount: 1,
      trackingNumber: '1ZRECORDED000000002',
      carrier: 'ups_rest',
      serviceCode: '03',
      recordedLabelReference: 'recorded-label-fixture-v1-invalid',
      recordedAt: '2026-07-29T14:00:00.000Z',
      shipTo: {
        name: 'Replay Customer',
        line1: '100 Replay Lane',
        city: 'Hartford',
        region: 'CT',
        postalCode: '06103',
        country: 'US',
      },
      lines: [{
        lineKey: 'line-1',
        productKey: 'product-1',
        title: 'Invalid fractional allocation',
        quantity: 1.5,
      }],
    },
  ),
  /OPERATIONS_REGRESSION_PACKING_SLIP_ALLOCATION_INVALID/,
)

console.log('Operations regression artifact checks passed.')
