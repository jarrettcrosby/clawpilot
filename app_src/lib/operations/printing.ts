export const PRINTER_TYPES = ['thermal', 'office'] as const
export const PRINTER_CONNECTION_MODES = ['local_agent', 'browser', 'system_service'] as const
export const PRINTER_STATUSES = ['online', 'offline', 'disabled'] as const
export const PRINTER_STATION_TYPES = ['pack', 'shipping', 'receiving', 'office'] as const
export const PRINT_FORMATS = ['ZPL', 'PDF', 'PNG'] as const
export const PRINT_MEDIA = ['label_4x6', 'label_4x8', 'letter', 'a4'] as const
export const PRINT_DOCUMENT_TYPES = [
  'shipping_label',
  'packing_slip',
  'pick_ticket',
  'carton_label',
  'pallet_label',
  'bill_of_lading',
  'customs_document',
  'return_label',
  'customer_insert',
] as const

export type PrinterType = typeof PRINTER_TYPES[number]
export type PrinterConnectionMode = typeof PRINTER_CONNECTION_MODES[number]
export type PrinterStatus = typeof PRINTER_STATUSES[number]
export type PrinterStationType = typeof PRINTER_STATION_TYPES[number]
export type PrintFormat = typeof PRINT_FORMATS[number]
export type PrintMedia = typeof PRINT_MEDIA[number]
export type PrintDocumentType = typeof PRINT_DOCUMENT_TYPES[number]

export type OperationsPrinterProfile = {
  id: string
  globalId: string
  warehouseId: string
  warehouseGlobalId: string
  warehouseName: string
  code: string
  name: string
  stationType: PrinterStationType
  printerType: PrinterType
  connectionMode: PrinterConnectionMode
  supportedFormats: PrintFormat[]
  supportedMedia: PrintMedia[]
  supportedDocumentTypes: PrintDocumentType[]
  defaultDocumentTypes: PrintDocumentType[]
  fallbackPrinterGlobalId: string | null
  fallbackPrinterName: string | null
  priority: number
  status: PrinterStatus
  rowVersion: number
  lastSeenAt: string | null
  updatedAt: string
}

export type OperationsPrinterWorkspace = {
  organizationId: string
  capabilities: {
    canView: boolean
    canManage: boolean
  }
  warehouses: Array<{ id: string; globalId: string; name: string }>
  printers: OperationsPrinterProfile[]
  generatedAt: string
}

export type OperationsPrinterInput = {
  globalId?: string
  expectedRowVersion?: number
  warehouseId: string
  code: string
  name: string
  stationType: PrinterStationType
  printerType: PrinterType
  connectionMode: PrinterConnectionMode
  supportedFormats: PrintFormat[]
  supportedMedia: PrintMedia[]
  supportedDocumentTypes: PrintDocumentType[]
  defaultDocumentTypes: PrintDocumentType[]
  fallbackPrinterGlobalId: string | null
  priority: number
  status: PrinterStatus
}

export type PrinterRouteRequest = {
  warehouseId: string
  documentType: PrintDocumentType
  format: PrintFormat
  media: PrintMedia
}

export type PrinterRouteSelection = {
  printer: OperationsPrinterProfile
  usedFallback: boolean
  reason: string
}

function supportsRoute(printer: OperationsPrinterProfile, request: PrinterRouteRequest) {
  return printer.warehouseId === request.warehouseId
    && printer.status !== 'disabled'
    && printer.supportedDocumentTypes.includes(request.documentType)
    && printer.supportedFormats.includes(request.format)
    && printer.supportedMedia.includes(request.media)
}

function byPriority(left: OperationsPrinterProfile, right: OperationsPrinterProfile) {
  return left.priority - right.priority || left.name.localeCompare(right.name)
}

export function selectPrinterRoute(
  printers: OperationsPrinterProfile[],
  request: PrinterRouteRequest,
): PrinterRouteSelection | null {
  const candidates = printers.filter((printer) => supportsRoute(printer, request))
  const byGlobalId = new Map(candidates.map((printer) => [printer.globalId, printer]))
  const defaults = candidates
    .filter((printer) => printer.defaultDocumentTypes.includes(request.documentType))
    .sort(byPriority)

  for (const printer of defaults) {
    if (printer.status === 'online') {
      return {
        printer,
        usedFallback: false,
        reason: `${printer.name} is the warehouse default for ${request.documentType}`,
      }
    }
    const fallback = printer.fallbackPrinterGlobalId
      ? byGlobalId.get(printer.fallbackPrinterGlobalId)
      : null
    if (fallback?.status === 'online') {
      return {
        printer: fallback,
        usedFallback: true,
        reason: `${printer.name} is offline; routed to configured fallback ${fallback.name}`,
      }
    }
  }

  const available = candidates.filter((printer) => printer.status === 'online').sort(byPriority)
  if (!available[0]) return null
  return {
    printer: available[0],
    usedFallback: false,
    reason: `Selected the highest-priority compatible printer in ${available[0].warehouseName}`,
  }
}
