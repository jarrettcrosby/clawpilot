import { createHash } from 'node:crypto'

export const PACKING_SLIP_TEMPLATE_VERSION = 'packing-slip-letter-v2'
export const PACKAGE_PACKING_LIST_TEMPLATE_VERSION =
  'packing-list-package-letter-v1'

export type PackingSlipSnapshot = {
  orderGlobalId: string
  orderNumber: string
  customerName: string
  customerGlobalId: string
  shipmentGlobalId: string
  trackingNumber: string
  carrier: string
  serviceCode: string
  shippedAt: string
  shipTo: {
    name: string
    line1: string
    line2?: string | null
    city: string
    region: string
    postalCode: string
    country: string
  }
  lines: Array<{
    productGlobalId: string
    productName: string
    channelSku: string
    quantity: number
  }>
}

export type RenderedPackingSlip = {
  payload: Buffer
  contentSha256: string
  byteLength: number
  filename: string
  mimeType: 'application/pdf'
  templateVersion: typeof PACKING_SLIP_TEMPLATE_VERSION
}

export type PackagePackingListSnapshot = {
  documentStage: 'warehouse_packing'
  orderGlobalId: string
  orderNumber: string
  customerName: string
  customerGlobalId: string
  fulfillmentPlanGlobalId: string
  warehouseId: string
  warehouseGlobalId: string
  warehouseName: string
  packageGlobalId: string
  packageNumber: number
  packageCount: number
  shipTo: PackingSlipSnapshot['shipTo']
  lines: PackingSlipSnapshot['lines']
}

export type RenderedPackagePackingList = Omit<
  RenderedPackingSlip,
  'templateVersion'
> & {
  templateVersion: typeof PACKAGE_PACKING_LIST_TEMPLATE_VERSION
}

function printable(value: unknown) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function pdfText(value: unknown) {
  return printable(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

function wrap(value: string, width: number) {
  const words = printable(value).split(' ').filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= width) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    current = word.length <= width ? word : word.slice(0, width)
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

function safeDocumentFilename(value: string, suffix: string) {
  const normalized = printable(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${normalized || 'order'}-${suffix}.pdf`
}

function safeFilename(value: string) {
  return safeDocumentFilename(value, 'packing-slip')
}

function buildMultiPagePdf(contents: string[]) {
  if (contents.length < 1) {
    throw new Error('PACKING_LIST_PAGE_REQUIRED')
  }
  const pageCount = contents.length
  const firstPageObject = 3
  const firstContentObject = firstPageObject + pageCount
  const regularFontObject = firstContentObject + pageCount
  const boldFontObject = regularFontObject + 1
  const pageReferences = contents.map(
    (_, index) => `${firstPageObject + index} 0 R`,
  )
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pageCount} >>`,
    ...contents.map((_, index) => (
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${regularFontObject} 0 R /F2 ${boldFontObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`
    )),
    ...contents.map((content) => (
      `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`
    )),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ]
  let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, 'binary'))
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(output, 'binary')
  output += `xref\n0 ${objects.length + 1}\n`
  output += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output, 'binary')
}

export function renderPackingSlip(snapshot: PackingSlipSnapshot): RenderedPackingSlip {
  const linesPerPage = 14
  const pageCount = Math.max(1, Math.ceil(snapshot.lines.length / linesPerPage))
  const pages = Array.from({ length: pageCount }, (_, pageIndex) => {
    const commands: string[] = []
    const text = (
      value: unknown,
      x: number,
      y: number,
      size = 10,
      bold = false,
    ) => {
      commands.push(
        `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${pdfText(value)}) Tj ET`,
      )
    }
    const line = (y: number) => (
      commands.push(`0.75 w 48 ${y} m 564 ${y} l S`)
    )

    text('ClawPilot Packing Slip', 48, 744, 18, true)
    text(`Order ${snapshot.orderNumber}`, 48, 718, 12, true)
    text(snapshot.orderGlobalId, 390, 718, 9)
    line(704)

    text('Ship to', 48, 682, 10, true)
    const addressLines = [
      snapshot.shipTo.name,
      snapshot.shipTo.line1,
      snapshot.shipTo.line2,
      `${snapshot.shipTo.city}, ${snapshot.shipTo.region} ${snapshot.shipTo.postalCode}`,
      snapshot.shipTo.country,
    ].filter(Boolean)
    addressLines.forEach(
      (value, index) => text(value, 48, 664 - index * 14, 10),
    )

    text('Shipment', 330, 682, 10, true)
    text(`${snapshot.carrier} ${snapshot.serviceCode}`, 330, 664, 10)
    text(snapshot.trackingNumber, 330, 650, 9)
    text(`Confirmed ${snapshot.shippedAt}`, 330, 636, 9)
    text(snapshot.shipmentGlobalId, 330, 622, 9)

    line(592)
    text('Qty', 48, 574, 9, true)
    text('Product', 88, 574, 9, true)
    text('SKU', 420, 574, 9, true)
    line(566)

    let y = 548
    const pageLines = snapshot.lines.slice(
      pageIndex * linesPerPage,
      (pageIndex + 1) * linesPerPage,
    )
    for (const item of pageLines) {
      text(item.quantity, 48, y, 10)
      const productLines = [
        wrap(item.productName, 48)[0],
        item.productGlobalId,
      ]
      productLines.forEach(
        (value, index) => text(value, 88, y - index * 12, 9),
      )
      text(item.channelSku || 'Not provided', 420, y, 9)
      y -= 30
      line(y + 10)
    }

    line(92)
    text(
      `Customer: ${snapshot.customerName} (${snapshot.customerGlobalId})`,
      48,
      72,
      8,
    )
    text(
      'Generated by ClawPilot from immutable shipment evidence.',
      48,
      56,
      8,
    )
    text(`Page ${pageIndex + 1} of ${pageCount}`, 492, 56, 8)
    return commands.join('\n')
  })

  const payload = buildMultiPagePdf(pages)
  return {
    payload,
    contentSha256: createHash('sha256').update(payload).digest('hex'),
    byteLength: payload.byteLength,
    filename: safeFilename(snapshot.orderNumber),
    mimeType: 'application/pdf',
    templateVersion: PACKING_SLIP_TEMPLATE_VERSION,
  }
}

export function renderPackagePackingList(
  snapshot: PackagePackingListSnapshot,
): RenderedPackagePackingList {
  const linesPerPage = 14
  const pageCount = Math.max(1, Math.ceil(snapshot.lines.length / linesPerPage))
  const pages = Array.from({ length: pageCount }, (_, pageIndex) => {
    const commands: string[] = []
    const text = (
      value: unknown,
      x: number,
      y: number,
      size = 10,
      bold = false,
    ) => {
      commands.push(
        `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${pdfText(value)}) Tj ET`,
      )
    }
    const line = (y: number) => commands.push(`0.75 w 48 ${y} m 564 ${y} l S`)

    text('ClawPilot Packing List', 48, 744, 18, true)
    text(`Order ${snapshot.orderNumber}`, 48, 718, 12, true)
    text(snapshot.orderGlobalId, 390, 718, 9)
    line(704)

    text('Ship to', 48, 682, 10, true)
    const addressLines = [
      snapshot.shipTo.name,
      snapshot.shipTo.line1,
      snapshot.shipTo.line2,
      `${snapshot.shipTo.city}, ${snapshot.shipTo.region} ${snapshot.shipTo.postalCode}`,
      snapshot.shipTo.country,
    ].filter(Boolean)
    addressLines.forEach((value, index) => text(value, 48, 664 - index * 14, 10))

    text('Physical package', 330, 682, 10, true)
    text(
      `Package ${snapshot.packageNumber} of ${snapshot.packageCount}`,
      330,
      664,
      11,
      true,
    )
    text(snapshot.packageGlobalId, 330, 648, 9)
    text(snapshot.warehouseName, 330, 632, 9)
    text(snapshot.warehouseGlobalId, 330, 616, 9)

    line(592)
    text('Qty', 48, 574, 9, true)
    text('Product', 88, 574, 9, true)
    text('SKU', 420, 574, 9, true)
    line(566)

    let y = 548
    const pageLines = snapshot.lines.slice(
      pageIndex * linesPerPage,
      (pageIndex + 1) * linesPerPage,
    )
    for (const item of pageLines) {
      text(item.quantity, 48, y, 10)
      const productLines = [
        wrap(item.productName, 48)[0],
        item.productGlobalId,
      ]
      productLines.forEach((value, index) => text(value, 88, y - index * 12, 9))
      text(item.channelSku || 'Not provided', 420, y, 9)
      y -= 30
      line(y + 10)
    }

    line(92)
    text(
      `Customer: ${snapshot.customerName} (${snapshot.customerGlobalId})`,
      48,
      72,
      8,
    )
    text(
      'Generated from immutable package-content allocation. No carrier action performed.',
      48,
      56,
      8,
    )
    text(`Page ${pageIndex + 1} of ${pageCount}`, 492, 56, 8)
    return commands.join('\n')
  })

  const payload = buildMultiPagePdf(pages)
  return {
    payload,
    contentSha256: createHash('sha256').update(payload).digest('hex'),
    byteLength: payload.byteLength,
    filename: safeDocumentFilename(
      `${snapshot.orderNumber}-package-${snapshot.packageNumber}`,
      'packing-list',
    ),
    mimeType: 'application/pdf',
    templateVersion: PACKAGE_PACKING_LIST_TEMPLATE_VERSION,
  }
}
