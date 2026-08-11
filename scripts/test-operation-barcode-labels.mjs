#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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

function loadBarcodeLabels() {
  const path = 'app_src/lib/operations/barcodeLabels.ts'
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
    Buffer,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === 'crypto') return crypto
      if (specifier === '@/lib/globalIds.mjs') {
        return {
          normalizeGlobalId(value, prefix) {
            const normalized = String(value || '').trim().toLowerCase()
            return new RegExp(`^${prefix}(?:[0-9]{7}|[0-9a-v]{12})$`).test(normalized)
              ? normalized
              : null
          },
        }
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function item(overrides = {}) {
  return {
    targetGlobalId: 'gp4513844',
    displayName: 'Test Product',
    humanCode: 'AG-Test-Test',
    barcodeValue: '657227000247',
    symbology: 'UPC-A',
    sourceIdentity: 'UPC-A',
    barcodeSource: 'provider',
    copies: 1,
    ...overrides,
  }
}

const labels = loadBarcodeLabels()

const plain = (value) => JSON.parse(JSON.stringify(value))

assert.deepEqual(
  plain(labels.providerBarcodeIdentity('657227000247')),
  { value: '657227000247', symbology: 'UPC-A', sourceIdentity: 'UPC-A' },
)
assert.deepEqual(
  plain(labels.providerBarcodeIdentity('4006381333931')),
  { value: '4006381333931', symbology: 'EAN-13', sourceIdentity: 'EAN-13' },
)
assert.deepEqual(
  plain(labels.providerBarcodeIdentity('96385074')),
  { value: '96385074', symbology: 'EAN-8', sourceIdentity: 'EAN-8' },
)
assert.deepEqual(
  plain(labels.providerBarcodeIdentity('10012345000017')),
  { value: '10012345000017', symbology: 'CODE128', sourceIdentity: 'GTIN-14' },
  'GTIN-14 must be truthfully identified as a source value while the printed symbology remains Code 128',
)
assert.equal(labels.providerBarcodeIdentity('657227000248'), null)
assert.equal(labels.providerBarcodeIdentity('not-a-retail-barcode'), null)

assert.equal(labels.internalProductBarcode('gp4513844'), 'CP1P-GP4513844')
assert.equal(labels.internalProductBarcode('gp0123456789av'), 'CP1P-GP0123456789AV')
assert.equal(labels.locationBarcode('gwl1234567'), 'CP1L-GWL1234567')
assert.equal(labels.locationBarcode('gwl0123456789av'), 'CP1L-GWL0123456789AV')
assert.deepEqual(plain(labels.parseClawPilotWarehouseBarcode('CP1P-GP4513844')), {
  version: 1,
  targetType: 'product',
  targetGlobalId: 'gp4513844',
})
assert.deepEqual(plain(labels.parseClawPilotWarehouseBarcode('CP1L-GWL0123456789AV')), {
  version: 1,
  targetType: 'location',
  targetGlobalId: 'gwl0123456789av',
})
assert.equal(labels.parseClawPilotWarehouseBarcode('657227000247'), null)

for (const [media, width, length] of [
  ['label_2x1', 406, 203],
  ['label_3x1', 609, 203],
  ['label_4x2', 812, 406],
  ['label_4x6', 812, 1218],
  ['label_4x8', 812, 1624],
]) {
  const zpl = labels.renderBarcodeLabelsZpl({
    targetType: 'product',
    warehouseGlobalId: 'gwh1234567',
    warehouseName: 'Main Warehouse',
    media,
    items: [item()],
  })
  assert.match(zpl, new RegExp(`\\^PW${width}`))
  assert.match(zpl, new RegExp(`\\^LL${length}`))
  assert.match(zpl, /\^BUN,/)
  assert.match(zpl, /\^BUN,[^\n]*\^FD65722700024\^FS/)
  assert.doesNotMatch(zpl, /\^BUN,[^\n]*\^FD657227000247\^FS/)
  assert.doesNotMatch(zpl, /\^BCN,/)
}

for (const [symbology, barcodeValue, command, encodedData] of [
  ['EAN-8', '96385074', '^B8N,', '9638507'],
  ['EAN-13', '4006381333931', '^BEN,', '400638133393'],
]) {
  const zpl = labels.renderBarcodeLabelsZpl({
    targetType: 'product',
    warehouseGlobalId: 'gwh1234567',
    warehouseName: 'Main Warehouse',
    media: 'label_3x1',
    items: [item({ barcodeValue, symbology, sourceIdentity: symbology })],
  })
  assert.ok(zpl.includes(command))
  const barcodeCommand = zpl.split('\n').find((line) => line.includes(command)) || ''
  assert.ok(barcodeCommand.includes(`^FD${encodedData}^FS`))
  assert.ok(!barcodeCommand.includes(`^FD${barcodeValue}^FS`))
}

const upcPreview = labels.renderBarcodeLabelsPreviewHtml('gbl1234567', {
  targetType: 'product',
  warehouseGlobalId: 'gwh1234567',
  warehouseName: 'Main Warehouse',
  media: 'label_3x1',
  items: [item()],
})
assert.match(upcPreview, /@page \{ size: 3in 1in/)
assert.match(upcPreview, /viewBox="0 0 115 90"/)
assert.match(upcPreview, /Printed UPC-A &middot; Source UPC-A/)

const gtinPreview = labels.renderBarcodeLabelsPreviewHtml('gbl1234568', {
  targetType: 'product',
  warehouseGlobalId: 'gwh1234567',
  warehouseName: 'Main Warehouse',
  media: 'label_4x2',
  items: [item({
    barcodeValue: '10012345000017',
    symbology: 'CODE128',
    sourceIdentity: 'GTIN-14',
  })],
})
assert.match(gtinPreview, /Printed CODE128 &middot; Source GTIN-14/)
assert.doesNotMatch(gtinPreview, /Printed GTIN-14/)

const migration = read('db/migrations/0262_operations_barcode_label_printing.sql')
const legacyGlobalIdSuffix = '[0-9]' + '{7}'
for (const fragment of [
  'operations_product_barcodes',
  "barcode_source text NOT NULL CHECK (barcode_source IN ('provider', 'internal'))",
  "source_identity IN ('UPC-A', 'EAN-8', 'EAN-13', 'GTIN-14', 'CODE128')",
  `barcode_value ~ '^CP1P-GP(?:${legacyGlobalIdSuffix}|[0-9A-V]{12})$'`,
  'operations_barcode_label_batches',
  'operations_print_artifacts_source_barcode_batch_fkey',
  "'product_label'",
  "'location_label'",
  "'label_2x1'",
  "'label_3x1'",
  "'label_4x2'",
  'operations_print_agents_supported_documents_valid',
  'operations_print_agents_supported_media_valid',
  'Migration 0262 does not claim them for an existing printer or print agent',
]) {
  assert.ok(migration.includes(fragment), `Missing barcode-label migration contract: ${fragment}`)
}
assert.doesNotMatch(
  migration,
  /UPDATE operations_print_(?:agents|printers)[\s\S]{0,500}product_label/,
  'Existing printer and agent capabilities must not be silently expanded',
)

const persistence = read('app_src/lib/persistence/operationBarcodeLabels.ts')
for (const fragment of [
  'providerBarcodeIdentity',
  'internalProductBarcode',
  'locationBarcode',
  'BARCODE_LABEL_MEDIA.includes(media as BarcodeLabelMedia)',
  'acquireTransactionAdvisoryLock',
  'operations.barcode_labels.generated',
  'printerDeliveryQueued: false',
]) {
  assert.ok(persistence.includes(fragment), `Missing barcode-label persistence contract: ${fragment}`)
}

const route = read('app_src/app/api/operations/barcode-labels/route.ts')
for (const fragment of [
  "'Idempotency-Key'",
  "'generate-batch'",
  "'enqueue-batch'",
  'canManage',
  'canExecute',
  "type: 'barcode_label_artifact'",
]) {
  assert.ok(route.includes(fragment), `Missing barcode-label route contract: ${fragment}`)
}

const previewRoute = read('app_src/app/api/operations/barcode-labels/[globalId]/preview/route.ts')
for (const fragment of [
  'requireRequestUser',
  'activeOperationsOrganizationId',
  'capabilities.canView',
  'readOperationsBarcodeLabelBatchPreviewFromPostgres',
  "'Content-Type': 'text/html; charset=utf-8'",
  "'Cache-Control': 'private, no-cache, max-age=0, must-revalidate'",
]) {
  assert.ok(previewRoute.includes(fragment), `Missing authenticated preview contract: ${fragment}`)
}
assert.doesNotMatch(
  previewRoute,
  /print.agent|enqueueOperationsPrintJob/i,
  'Browser preview must remain available without a local print agent',
)

const dialog = read('app_src/components/operations/BarcodeLabelsDialog.tsx')
for (const fragment of [
  'compatiblePrintersForBatch',
  'printer.supportedMedia.includes(labelBatch.media)',
  "labelBatch.targetType === 'product'",
  "preferredPrinters[labelBatch.globalId]",
]) {
  assert.ok(dialog.includes(fragment), `Missing batch-specific printer routing UI: ${fragment}`)
}
const printerPanel = read('app_src/components/operations/PrinterConfigurationPanel.tsx')
for (const fragment of [
  "import BarcodeLabelsDialog from '@/components/operations/BarcodeLabelsDialog'",
  'setBarcodeLabelsOpen(true)',
  '<BarcodeLabelsDialog',
]) {
  assert.ok(printerPanel.includes(fragment), `Missing reachable barcode-label UI entry point: ${fragment}`)
}

const wearable = read('app_src/lib/persistence/wearablePicking.ts')
assert.ok(wearable.includes('operations_product_barcodes'))
assert.ok(wearable.includes("row.assigned_barcode === null"))
assert.ok(wearable.includes('providerBarcodeIdentity(row.barcode_snapshot)?.value'))

for (const media of [
  'label_2x1',
  'label_3x1',
  'label_4x2',
  'label_4x6',
  'label_4x8',
]) {
  assert.ok(persistence.includes(media), `Workspace must recognize ${media}`)
}
assert.ok(
  persistence.includes('BARCODE_LABEL_MEDIA.includes(media as BarcodeLabelMedia)'),
  'A printer configured only for compact barcode-label media must remain compatible',
)

console.log('operation barcode labels: ok')
