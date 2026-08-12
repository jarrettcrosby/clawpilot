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

assert.equal(labels.BARCODE_LABEL_TEMPLATE_VERSION, 'warehouse-barcode-zpl-v3')

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

const boxesOverlap = (left, right) => (
  left[0] < right[0] + right[2]
  && left[0] + left[2] > right[0]
  && left[1] < right[1] + right[3]
  && left[1] + left[3] > right[1]
)

const mediaContracts = [
  {
    media: 'label_2x1', width: 406, length: 203, widthInches: 2, heightInches: 1,
    minimumModuleWidth: 1, maximumModuleWidth: 3,
    boxes: {
      title: [12, 5, 382, 22], linear: [0, 32, 406, 76], value: [12, 113, 382, 16],
      details: [12, 135, 382, 16], identity: [12, 157, 382, 13], footer: [12, 178, 382, 11],
    },
  },
  {
    media: 'label_3x1', width: 609, length: 203, widthInches: 3, heightInches: 1,
    minimumModuleWidth: 1, maximumModuleWidth: 5,
    boxes: {
      title: [14, 5, 581, 24], linear: [0, 34, 609, 84], value: [14, 122, 581, 18],
      details: [14, 144, 581, 17], identity: [14, 166, 581, 14], footer: [14, 184, 581, 11],
    },
  },
  {
    media: 'label_4x2', width: 812, length: 406, widthInches: 4, heightInches: 2,
    minimumModuleWidth: 2, maximumModuleWidth: 4, qrMagnification: 7,
    boxes: {
      title: [24, 12, 764, 36], linear: [0, 60, 812, 92], value: [24, 160, 764, 24],
      qr: [24, 198, 203, 203], details: [250, 202, 538, 50],
      identity: [250, 270, 538, 26], footer: [250, 324, 538, 52],
    },
  },
  {
    media: 'label_4x6', width: 812, length: 1218, widthInches: 4, heightInches: 6,
    minimumModuleWidth: 2, maximumModuleWidth: 5, qrMagnification: 10,
    boxes: {
      title: [36, 30, 740, 80], linear: [0, 130, 812, 600], value: [36, 750, 740, 50],
      qr: [36, 850, 290, 290], details: [370, 850, 406, 90],
      identity: [370, 970, 406, 55], footer: [370, 1050, 406, 80],
    },
  },
  {
    media: 'label_4x8', width: 812, length: 1624, widthInches: 4, heightInches: 8,
    minimumModuleWidth: 2, maximumModuleWidth: 5, qrMagnification: 10,
    boxes: {
      title: [36, 40, 740, 100], linear: [0, 170, 812, 900], value: [36, 1090, 740, 60],
      qr: [36, 1260, 290, 290], details: [370, 1260, 406, 105],
      identity: [370, 1395, 406, 65], footer: [370, 1480, 406, 90],
    },
  },
]

function testQrFormatBits(mask) {
  let remainder = mask
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  }
  return ((mask << 10) | remainder) ^ 0x5412
}

function testQrMask(mask, x, y) {
  if (mask === 0) return (x + y) % 2 === 0
  if (mask === 1) return y % 2 === 0
  if (mask === 2) return x % 3 === 0
  if (mask === 3) return (x + y) % 3 === 0
  if (mask === 4) return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
  if (mask === 5) return (x * y) % 2 + (x * y) % 3 === 0
  if (mask === 6) return ((x * y) % 2 + (x * y) % 3) % 2 === 0
  return ((x + y) % 2 + (x * y) % 3) % 2 === 0
}

function decodeQrV1M(matrix) {
  assert.equal(matrix.length, 21)
  assert.ok(matrix.every((row) => row.length === 21))
  let format = 0
  for (let index = 0; index <= 5; index += 1) if (matrix[index][8]) format |= 1 << index
  if (matrix[7][8]) format |= 1 << 6
  if (matrix[8][8]) format |= 1 << 7
  if (matrix[8][7]) format |= 1 << 8
  for (let index = 9; index < 15; index += 1) if (matrix[8][14 - index]) format |= 1 << index
  const mask = Array.from({ length: 8 }, (_, current) => current)
    .find((current) => testQrFormatBits(current) === format)
  assert.notEqual(mask, undefined, 'QR format information must identify a valid M-level mask')

  const functions = Array.from({ length: 21 }, () => Array(21).fill(false))
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < 21 && y < 21) functions[y][x] = true }
  for (let index = 0; index < 21; index += 1) { mark(6, index); mark(index, 6) }
  for (const [centerX, centerY] of [[3, 3], [17, 3], [3, 17]]) {
    for (let y = -4; y <= 4; y += 1) for (let x = -4; x <= 4; x += 1) mark(centerX + x, centerY + y)
  }
  for (let index = 0; index <= 5; index += 1) mark(8, index)
  mark(8, 7); mark(8, 8); mark(7, 8)
  for (let index = 9; index < 15; index += 1) mark(14 - index, 8)
  for (let index = 0; index < 8; index += 1) mark(20 - index, 8)
  for (let index = 8; index < 15; index += 1) mark(8, 6 + index)
  mark(8, 13)

  const bits = []
  for (let right = 20; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < 21; vertical += 1) {
      const y = ((right + 1) & 2) === 0 ? 20 - vertical : vertical
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset
        if (!functions[y][x]) bits.push(Number(matrix[y][x] !== testQrMask(mask, x, y)))
      }
    }
  }
  assert.equal(bits.length, 208, 'Version 1 has exactly 26 codewords and no remainder modules')
  const codewords = Array.from({ length: 26 }, (_, index) => (
    Number.parseInt(bits.slice(index * 8, index * 8 + 8).join(''), 2)
  ))
  const dataBits = codewords.slice(0, 16).flatMap((codeword) => (
    Array.from({ length: 8 }, (_, bit) => (codeword >>> (7 - bit)) & 1)
  ))
  let cursor = 0
  const readBits = (length) => {
    const result = Number.parseInt(dataBits.slice(cursor, cursor + length).join(''), 2)
    cursor += length
    return result
  }
  const mode = readBits(4)
  let decoded = ''
  if (mode === 0b0001) {
    let remaining = readBits(10)
    while (remaining >= 3) { decoded += String(readBits(10)).padStart(3, '0'); remaining -= 3 }
    if (remaining === 2) decoded += String(readBits(7)).padStart(2, '0')
    if (remaining === 1) decoded += String(readBits(4))
  } else {
    assert.equal(mode, 0b0010)
    let remaining = readBits(9)
    while (remaining >= 2) {
      const pair = readBits(11)
      decoded += '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'[Math.floor(pair / 45)]
      decoded += '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'[pair % 45]
      remaining -= 2
    }
    if (remaining === 1) decoded += '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'[readBits(6)]
  }
  return { decoded, mask, codewords }
}

const qrConformanceVectors = new Map([
  ['657227000247', '76fb3c73762cc789810028fcbbf3b21a36671ec8b2abd40995d1ddba2dfcdc3e'],
  ['CP1L-GWL0123456789AV', '4ac3733fd71b3fcb5aaf9c111e3d88633a3a064e34ad1e4b016351208be895cc'],
])
for (const [value, expectedDigest] of qrConformanceVectors) {
  const modules = plain(labels.warehouseBarcodeQrModules(value))
  const digest = crypto.createHash('sha256')
    .update(modules.map((row) => row.map(Number).join('')).join('\n'))
    .digest('hex')
  assert.equal(digest, expectedDigest, 'QR modules must match the independently generated qrcode 1.5.4 vector')
  assert.equal(decodeQrV1M(modules).decoded, value, 'QR modules must independently decode to the exact barcode value')
}

const representativeItems = [
  item(),
  item({ barcodeValue: '96385074', symbology: 'EAN-8', sourceIdentity: 'EAN-8' }),
  item({ barcodeValue: '4006381333931', symbology: 'EAN-13', sourceIdentity: 'EAN-13' }),
  item({ barcodeValue: '10012345000017', symbology: 'CODE128', sourceIdentity: 'GTIN-14' }),
  item({
    targetGlobalId: 'gp0123456789av', barcodeValue: 'CP1P-GP0123456789AV',
    symbology: 'CODE128', sourceIdentity: 'CODE128', barcodeSource: 'internal',
  }),
  item({
    targetGlobalId: 'gwl0123456789av', displayName: 'PICKFACE-01', humanCode: 'FULFILLMENT - pick',
    barcodeValue: 'CP1L-GWL0123456789AV', symbology: 'CODE128',
    sourceIdentity: 'LOCATION', barcodeSource: 'location',
  }),
]

for (const contract of mediaContracts) {
  const entries = Object.entries(contract.boxes)
  for (const [name, box] of entries) {
    assert.ok(box[0] >= 0 && box[1] >= 0, `${contract.media} ${name} must start in bounds`)
    assert.ok(box[0] + box[2] <= contract.width, `${contract.media} ${name} must fit horizontally`)
    assert.ok(box[1] + box[3] <= contract.length, `${contract.media} ${name} must fit vertically`)
  }
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      assert.ok(
        !boxesOverlap(entries[left][1], entries[right][1]),
        `${contract.media} ${entries[left][0]} and ${entries[right][0]} must not overlap`,
      )
    }
  }
  if (contract.qrMagnification) {
    assert.equal(contract.boxes.qr[2], 29 * contract.qrMagnification)
    assert.equal(contract.boxes.qr[3], 29 * contract.qrMagnification)
  } else {
    assert.equal(contract.boxes.qr, undefined)
  }

  for (const representative of representativeItems) {
    const zpl = labels.renderBarcodeLabelsZpl({
      targetType: representative.barcodeSource === 'location' ? 'location' : 'product',
      warehouseGlobalId: 'gwh1234567', warehouseName: 'Main Warehouse',
      media: contract.media, items: [representative],
    })
    assert.match(zpl, new RegExp(`\\^PW${contract.width}`))
    assert.match(zpl, new RegExp(`\\^LL${contract.length}`))
    const by = zpl.match(/\^BY(\d+),2,(\d+)/)
    const barcodeLine = zpl.split('\n').find((line) => /\^(?:BU|B8|BE|BC)N,/.test(line)) || ''
    const position = barcodeLine.match(/\^FO(\d+),(\d+)/)
    assert.ok(by && position, `${contract.media} must place the primary linear barcode`)
    const moduleWidth = Number(by[1])
    const barcodeHeight = Number(by[2])
    const barcodeX = Number(position[1])
    const barcodeY = Number(position[2])
    const modules = representative.symbology === 'EAN-8'
      ? 67
      : representative.symbology === 'UPC-A' || representative.symbology === 'EAN-13'
        ? 95
        : 11 * (representative.barcodeValue.length + 2) + 15
    const quiet = representative.symbology === 'EAN-13' ? { left: 11, right: 7 } : { left: 10, right: 10 }
    const linear = contract.boxes.linear
    assert.ok(moduleWidth >= contract.minimumModuleWidth, `${contract.media} must preserve minimum linear module width`)
    assert.equal(barcodeY, linear[1])
    assert.equal(barcodeHeight, linear[3])
    assert.ok(barcodeX - linear[0] >= quiet.left * moduleWidth, `${contract.media} must preserve left quiet zone`)
    assert.ok(
      linear[0] + linear[2] - barcodeX - modules * moduleWidth >= quiet.right * moduleWidth,
      `${contract.media} must preserve right quiet zone`,
    )

    if (contract.qrMagnification) {
      const qr = contract.boxes.qr
      assert.match(
        zpl,
        new RegExp(`\\^FO${qr[0] + 4 * contract.qrMagnification},${qr[1] + 4 * contract.qrMagnification}`
          + `\\^BQN,2,${contract.qrMagnification}\\^FDMA,${representative.barcodeValue}\\^FS`),
      )
      assert.match(zpl, /QR same value/)
    } else {
      assert.doesNotMatch(zpl, /\^BQN,/)
      assert.match(zpl, /linear only/)
    }
    assert.match(zpl, /warehouse-barcode-zpl-v3/)
  }

  const preview = labels.renderBarcodeLabelsPreviewHtml(`gbl-${contract.media}`, {
    targetType: 'location', warehouseGlobalId: 'gwh1234567', warehouseName: 'Main Warehouse',
    media: contract.media, items: [representativeItems.at(-1)],
  })
  assert.match(preview, new RegExp(`@page \\{ size: ${contract.widthInches}in ${contract.heightInches}in`))
  assert.match(preview, new RegExp(`data-media="${contract.media}"`))
  for (const [name, box] of entries) {
    assert.match(preview, new RegExp(`data-${name}-box="${box.join(',')}"`))
  }
  const previewLinear = contract.boxes.linear
  const previewModules = 11 * ('CP1L-GWL0123456789AV'.length + 2) + 15
  const previewModuleWidth = Math.min(
    contract.maximumModuleWidth,
    Math.floor(previewLinear[2] / (previewModules + 20)),
  )
  const previewLinearWidth = (previewModules + 20) * previewModuleWidth
  const previewLinearX = previewLinear[0] + Math.floor((previewLinear[2] - previewLinearWidth) / 2)
  assert.match(
    preview,
    new RegExp(`data-linear-render-box="${previewLinearX},${previewLinear[1]},${previewLinearWidth},${previewLinear[3]}"`),
  )
  assert.match(preview, new RegExp(`data-linear-module-width="${previewModuleWidth}"`))
  if (contract.qrMagnification) {
    assert.match(preview, /data-code-mode="linear-and-qr"/)
    assert.match(preview, /<svg class="qr-code" viewBox="0 0 29 29"/)
    assert.match(preview, /data-version="1" data-modules="21" data-quiet-zone="4"/)
    assert.match(preview, /aria-label="QR barcode CP1L-GWL0123456789AV"/)
    assert.doesNotMatch(preview, /https?:\/\//)
  } else {
    assert.match(preview, /data-code-mode="linear-only"/)
    assert.doesNotMatch(preview, /class="qr-code"/)
  }
}

const legacySnapshot = {
  targetType: 'product', warehouseGlobalId: 'gwh1234567', warehouseName: 'Main Warehouse',
  media: 'label_4x6', items: [item()],
}
for (const [version, expectedDigest] of [
  ['warehouse-barcode-zpl-v1', '83619ef06f6a27101230c148c7e3fe1d470ccbfc67c3e9c7a51b043cd47c0f41'],
  ['warehouse-barcode-zpl-v2', '0ea5c26a44eefef4ac27a33e99fc69e029593aa426947ec6fda8ef413c18ddeb'],
]) {
  const preview = labels.renderBarcodeLabelsPreviewHtml('gbl1234567', legacySnapshot, version)
  assert.equal(
    crypto.createHash('sha256').update(preview).digest('hex'),
    expectedDigest,
    `${version} preview must remain byte-for-byte compatible with its immutable batch`,
  )
  assert.doesNotMatch(preview, /class="qr-code"/)
}
assert.throws(
  () => labels.renderBarcodeLabelsPreviewHtml(
    'gbl1234567', legacySnapshot, 'warehouse-barcode-zpl-unknown',
  ),
  /template version is not supported/,
)
assert.throws(
  () => labels.renderBarcodeLabelsZpl({
    ...legacySnapshot,
    items: [item({ barcodeValue: 'CP1^XZ' })],
  }),
  /barcode value is invalid/,
  'ZPL control characters must never be interpolated into barcode data',
)
assert.throws(
  () => labels.warehouseBarcodeQrModules('CP1L-GWL0123456789AVX'),
  /barcode value is invalid/,
  'The QR version bound must reject values beyond the normalized Global ID contract',
)

const phoneCameraScanner = read('clients/apple/Apps/iPhone/PhoneCameraScanner.swift')
assert.match(
  phoneCameraScanner,
  /recognizedDataTypes: \[\.barcode\(symbologies: \[\.code128, \.ean8, \.ean13, \.upce, \.qr\]\)\]/,
  'The iPhone live scanner must accept the QR duplicate as well as primary retail and Code 128 labels',
)
assert.match(
  phoneCameraScanner,
  /request\.symbologies = \[\.code128, \.ean8, \.ean13, \.upce, \.qr\]/,
  'The iPhone high-resolution fallback must accept the same QR symbology set',
)

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
  "media === 'label_2x1' || media === 'label_3x1'",
  'Compact stock prints the primary linear barcode only.',
  'Prints the primary linear barcode plus a QR copy for phone and glasses cameras.',
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
