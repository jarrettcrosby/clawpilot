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

const mediaContracts = [
  {
    media: 'label_2x1', width: 406, length: 203, moduleWidth: 3, barcodeHeight: 76,
    widthInches: 2, heightInches: 1, previewBarcodeHeight: 0.4,
    previewRows: [0.14, 0.4, 0.1, 0.11, 0.09], previewGap: 0.02, previewPaddingY: 0.04,
  },
  {
    media: 'label_3x1', width: 609, length: 203, moduleWidth: 5, barcodeHeight: 84,
    widthInches: 3, heightInches: 1, previewBarcodeHeight: 0.42,
    previewRows: [0.15, 0.42, 0.09, 0.11, 0.07], previewGap: 0.02, previewPaddingY: 0.04,
  },
  {
    media: 'label_4x2', width: 812, length: 406, moduleWidth: 7, barcodeHeight: 180,
    widthInches: 4, heightInches: 2, previewBarcodeHeight: 0.82,
    previewRows: [0.28, 0.82, 0.16, 0.22, 0.14], previewGap: 0.035, previewPaddingY: 0.12,
  },
  {
    media: 'label_4x6', width: 812, length: 1218, moduleWidth: 7, barcodeHeight: 720,
    widthInches: 4, heightInches: 6, previewBarcodeHeight: 3.5,
    previewRows: [0.8, 3.5, 0.3, 0.4, 0.37], previewGap: 0.0375, previewPaddingY: 0.24,
  },
  {
    media: 'label_4x8', width: 812, length: 1624, moduleWidth: 7, barcodeHeight: 1020,
    widthInches: 4, heightInches: 8, previewBarcodeHeight: 5,
    previewRows: [0.9, 5, 0.35, 0.5, 0.37], previewGap: 0.08, previewPaddingY: 0.28,
  },
]

const renderedMedia = new Map()

for (const contract of mediaContracts) {
  const { media, width, length } = contract
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

  const by = zpl.match(/\^BY(\d+),2,(\d+)/)
  assert.ok(by, `${media} must declare barcode module width and height`)
  assert.equal(Number(by[1]), contract.moduleWidth, `${media} module width must scale with media width`)
  assert.equal(Number(by[2]), contract.barcodeHeight, `${media} barcode height must scale with media height`)

  const barcode = zpl.match(/\^FO(\d+),(\d+)\^BUN,(\d+),/)
  assert.ok(barcode, `${media} must place the UPC-A barcode explicitly`)
  const barcodeX = Number(barcode[1])
  const barcodeY = Number(barcode[2])
  const barcodeHeight = Number(barcode[3])
  const quietZoneDots = contract.moduleWidth * 10
  const barcodeWidth = contract.moduleWidth * 95
  assert.ok(barcodeX >= quietZoneDots, `${media} must preserve the left UPC quiet zone`)
  assert.ok(
    width - barcodeX - barcodeWidth >= quietZoneDots,
    `${media} must preserve the right UPC quiet zone`,
  )
  assert.ok(barcodeY + barcodeHeight <= length, `${media} barcode must not overflow vertically`)

  for (const field of zpl.matchAll(/\^FO(\d+),(\d+)\^A0N,(\d+),(\d+)\^FB(\d+),(\d+),/g)) {
    const [, x, y, fontHeight, , fieldWidth, lines] = field.map(Number)
    assert.ok(x + fieldWidth <= width, `${media} text field must not overflow horizontally`)
    assert.ok(y + fontHeight * lines <= length, `${media} text field must not overflow vertically`)
  }

  const preview = labels.renderBarcodeLabelsPreviewHtml(`gbl-${media}`, {
    targetType: 'product',
    warehouseGlobalId: 'gwh1234567',
    warehouseName: 'Main Warehouse',
    media,
    items: [item()],
  })
  assert.match(preview, new RegExp(`@page \\{ size: ${contract.widthInches}in ${contract.heightInches}in`))
  assert.match(preview, new RegExp(`data-media="${media}"`))
  assert.match(preview, new RegExp(`${contract.previewBarcodeHeight}in`))
  const occupiedPreviewHeight = contract.previewRows.reduce((sum, row) => sum + row, 0)
    + contract.previewGap * 4
    + contract.previewPaddingY * 2
  assert.ok(
    occupiedPreviewHeight <= contract.heightInches + Number.EPSILON * 4,
    `${media} preview layout must not overflow its physical page`,
  )
  assert.ok(
    occupiedPreviewHeight >= contract.heightInches * 0.99,
    `${media} preview layout must use the available physical page`,
  )
  renderedMedia.set(media, { zpl, preview })
}

assert.ok(
  mediaContracts.find(({ media }) => media === 'label_4x6').barcodeHeight
    >= mediaContracts.find(({ media }) => media === 'label_3x1').barcodeHeight * 8,
  '4 x 6 ZPL must render a substantially taller barcode than 3 x 1',
)
assert.ok(
  mediaContracts.find(({ media }) => media === 'label_4x6').previewBarcodeHeight
    >= mediaContracts.find(({ media }) => media === 'label_3x1').previewBarcodeHeight * 8,
  '4 x 6 browser preview must render a substantially taller barcode than 3 x 1',
)
assert.match(
  renderedMedia.get('label_4x6').zpl,
  /ClawPilot product \(provider\) - warehouse-barcode-zpl-v2/,
)

const compactCode128 = labels.renderBarcodeLabelsZpl({
  targetType: 'location',
  warehouseGlobalId: 'gwh1234567',
  warehouseName: 'Main Warehouse',
  media: 'label_2x1',
  items: [item({
    targetGlobalId: 'gwl0123456789av',
    displayName: 'PICKFACE-01',
    humanCode: 'FULFILLMENT - pick',
    barcodeValue: 'CP1L-GWL0123456789AV',
    symbology: 'CODE128',
    sourceIdentity: 'LOCATION',
    barcodeSource: 'location',
  })],
})
const compactCode128By = compactCode128.match(/\^BY(\d+),2,(\d+)/)
const compactCode128Barcode = compactCode128.match(/\^FO(\d+),(\d+)\^BCN,(\d+),/)
assert.ok(compactCode128By && compactCode128Barcode)
const compactCode128ModuleWidth = Number(compactCode128By[1])
const compactCode128Modules = 11 * ('CP1L-GWL0123456789AV'.length + 2) + 15
const compactCode128X = Number(compactCode128Barcode[1])
assert.ok(compactCode128X >= compactCode128ModuleWidth * 10)
assert.ok(
  406 - compactCode128X - compactCode128Modules * compactCode128ModuleWidth
    >= compactCode128ModuleWidth * 10,
  '2 x 1 must preserve Code 128 quiet zones without overflowing',
)
assert.match(compactCode128, /GWL0123456789AV - CODE128\/LOCATION/)
assert.match(compactCode128, /ClawPilot location \(location\) - warehouse-barcode-zpl-v2/)

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
assert.match(upcPreview, /warehouse-barcode-zpl-v2/)

const legacyPreview = labels.renderBarcodeLabelsPreviewHtml('gbl1234567', {
  targetType: 'product',
  warehouseGlobalId: 'gwh1234567',
  warehouseName: 'Main Warehouse',
  media: 'label_4x6',
  items: [item()],
}, 'warehouse-barcode-zpl-v1')
assert.match(legacyPreview, /\.barcode \{ display: block; width: 100%; height: 1\.25in;/)
assert.doesNotMatch(legacyPreview, /data-media="label_4x6"/)
assert.throws(
  () => labels.renderBarcodeLabelsPreviewHtml('gbl1234567', {
    targetType: 'product',
    warehouseGlobalId: 'gwh1234567',
    warehouseName: 'Main Warehouse',
    media: 'label_4x6',
    items: [item()],
  }, 'warehouse-barcode-zpl-unknown'),
  /template version is not supported/,
)

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
  'label_batch.template_version',
  'renderBarcodeLabelsPreviewHtml(batchGlobalId, snapshot, row.template_version)',
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
  'label="Label size"',
  'setMedia(event.target.value as typeof media)',
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
