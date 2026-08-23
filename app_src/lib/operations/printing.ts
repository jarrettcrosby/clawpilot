export const PRINTER_TYPES = ['thermal', 'nonthermal'] as const
export const PRINTER_CONNECTION_MODES = ['local_agent', 'browser', 'system_service'] as const
export const PRINTER_STATUSES = ['online', 'offline', 'disabled'] as const
export const PRINTER_STATION_TYPES = ['pack', 'shipping', 'receiving', 'office'] as const
export const PRINT_FORMATS = ['ZPL', 'PDF', 'PNG'] as const
export const PRINT_MEDIA = [
  'label_2x1',
  'label_3x1',
  'label_4x2',
  'label_4x6',
  'label_4x8',
  'letter',
  'a4',
] as const
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
  'product_label',
  'location_label',
] as const
export const DURABLE_PRINT_DOCUMENT_TYPES = [
  'shipping_label',
  'packing_slip',
  'product_label',
  'location_label',
] as const
export const PRINT_PAYLOAD_ENCODINGS = ['utf8', 'base64'] as const
export const PRINT_AGENT_STATUSES = ['active', 'revoked'] as const
export const PRINT_JOB_STATUSES = [
  'queued',
  'claimed',
  'delivered',
  'failed',
  'cancelled',
  'printed',
  'rerouted',
] as const

export type PrinterType = typeof PRINTER_TYPES[number]
export type PrinterConnectionMode = typeof PRINTER_CONNECTION_MODES[number]
export type PrinterStatus = typeof PRINTER_STATUSES[number]
export type PrinterStationType = typeof PRINTER_STATION_TYPES[number]
export type PrintFormat = typeof PRINT_FORMATS[number]
export type PrintMedia = typeof PRINT_MEDIA[number]
export type PrintDocumentType = typeof PRINT_DOCUMENT_TYPES[number]
export type DurablePrintDocumentType = typeof DURABLE_PRINT_DOCUMENT_TYPES[number]
export type PrintPayloadEncoding = typeof PRINT_PAYLOAD_ENCODINGS[number]
export type PrintAgentStatus = typeof PRINT_AGENT_STATUSES[number]
export type PrintJobStatus = typeof PRINT_JOB_STATUSES[number]

export type PrintAgentCapabilities = {
  supportedFormats: PrintFormat[]
  supportedMedia: PrintMedia[]
  supportedDocumentTypes: PrintDocumentType[]
}

export const LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES: PrintAgentCapabilities = {
  supportedFormats: ['ZPL'],
  supportedMedia: ['label_4x6'],
  supportedDocumentTypes: ['shipping_label'],
}

export const DEFAULT_PRINT_AGENT_CAPABILITIES: PrintAgentCapabilities = {
  supportedFormats: ['ZPL'],
  supportedMedia: [
    'label_2x1',
    'label_3x1',
    'label_4x2',
    'label_4x6',
    'label_4x8',
  ],
  supportedDocumentTypes: [
    'shipping_label',
    'product_label',
    'location_label',
  ],
}

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
  localPrintAgentGlobalId: string | null
  localPrintAgentName: string | null
  localPrintAgentStatus: PrintAgentStatus | null
  localPrintAgentLastSeenAt: string | null
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
    canExecute: boolean
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
  localPrintAgentGlobalId: string | null
  priority: number
  status: PrinterStatus
}

export type OperationsPrintAgentProfile = {
  id: string
  globalId: string
  warehouseId: string
  warehouseGlobalId: string
  warehouseName: string
  name: string
  status: PrintAgentStatus
  credentialVersion: number
  supportedFormats: PrintFormat[]
  supportedMedia: PrintMedia[]
  supportedDocumentTypes: PrintDocumentType[]
  assignedPrinters: Array<{ globalId: string; name: string }>
  enrolledBy: string | null
  enrolledAt: string
  rotatedAt: string | null
  revokedAt: string | null
  lastSeenAt: string | null
}

export type OperationsPrintAgentWorkspace = {
  organizationId: string
  capabilities: {
    canView: boolean
    canManage: boolean
  }
  agents: OperationsPrintAgentProfile[]
  generatedAt: string
}

export type OperationsPrintAgentCredential = {
  agent: OperationsPrintAgentProfile
  credential: string | null
}

export type OperationsPrintAttemptListItem = {
  attemptNumber: number
  sequenceNumber: number
  state: PrintJobStatus
  actorType: 'user' | 'local_print_agent' | 'system'
  actorEmail: string | null
  printAgentGlobalId: string | null
  printerGlobalId: string
  printerName: string
  detail: string | null
  errorCode: string | null
  errorMessage: string | null
  deviceJobReference: string | null
  deliveryEvidence: string | null
  physicalOutputVerified: boolean
  occurredAt: string
}

export type OperationsPrintJobListItem = {
  id: string
  globalId: string
  documentType: DurablePrintDocumentType | null
  format: PrintFormat | null
  media: PrintMedia | null
  artifactGlobalId: string | null
  artifactContentSha256: string | null
  artifactByteLength: number | null
  artifactCreatedBy: string | null
  artifactCreatedAt: string | null
  sourceLabelGlobalId: string | null
  sourceLabelStatus: string | null
  carrier: string | null
  carrierServiceCode: string | null
  carrierEnvironment: string | null
  labelCreatedAt: string | null
  labelVoidedAt: string | null
  labelVoidedBy: string | null
  sourceOrderGlobalId: string | null
  sourceOrderNumber: string | null
  sourceShipmentGlobalId: string | null
  trackingNumber: string | null
  packageGlobalId: string | null
  packageNumber: number | null
  packageLengthMm: number | null
  packageWidthMm: number | null
  packageHeightMm: number | null
  packageWeightGrams: number | null
  shipToName: string | null
  shipToCity: string | null
  shipToRegion: string | null
  shipToPostalCode: string | null
  shipToCountry: string | null
  warehouseGlobalId: string
  warehouseName: string
  stationType: PrinterStationType
  printerGlobalId: string
  printerName: string
  requestedPrinterGlobalId: string
  requestedPrinterName: string
  fallbackPrinterGlobalId: string | null
  fallbackPrinterName: string | null
  printAgentGlobalId: string | null
  printAgentName: string | null
  status: PrintJobStatus
  routingReason: string
  attempts: number
  maxAttempts: number
  availableAt: string
  claimExpiresAt: string | null
  deliveredAt: string | null
  lastError: string | null
  reprintOfJobGlobalId: string | null
  reprintReason: string | null
  enqueuedBy: string | null
  attemptHistory: OperationsPrintAttemptListItem[]
  createdAt: string
  updatedAt: string
}

export type OperationsPrintJobWorkspace = {
  organizationId: string
  capabilities: {
    canView: boolean
    canManage: boolean
    canExecute: boolean
    canReprint: boolean
  }
  jobs: OperationsPrintJobListItem[]
  generatedAt: string
}

export type OperationsPrintAgentContext = {
  id: string
  globalId: string
  organizationId: string
  warehouseId: string
  name: string
  credentialVersion: number
  supportedFormats: PrintFormat[]
  supportedMedia: PrintMedia[]
  supportedDocumentTypes: PrintDocumentType[]
}

export type OperationsPrintClaimJob = {
  globalId: string
  claimToken: string
  serverNow: string
  claimExpiresAt: string
  document: {
    globalId: string
    type: DurablePrintDocumentType
    format: PrintFormat
    media: PrintMedia
    contentSha256: string
    byteLength: number
    storageReference: string
    inlinePayload: string | null
    encoding: PrintPayloadEncoding | null
  }
  printer: {
    globalId: string
    code: string
    name: string
  }
  attempt: number
}

export type PrinterRouteRequest = {
  warehouseId: string
  documentType: PrintDocumentType
  format: PrintFormat
  media: PrintMedia
  durable?: boolean
  preferredPrinterGlobalId?: string | null
}

export type PrinterRouteSelection = {
  printer: OperationsPrinterProfile
  requestedPrinter: OperationsPrinterProfile
  fallbackPrinter: OperationsPrinterProfile | null
  usedFallback: boolean
  reason: string
}

const LABEL_MEDIA = new Set<PrintMedia>([
  'label_2x1',
  'label_3x1',
  'label_4x2',
  'label_4x6',
  'label_4x8',
])
const SHIPPING_LABEL_MEDIA = new Set<PrintMedia>(['label_4x6', 'label_4x8'])
const DOCUMENT_MEDIA = new Set<PrintMedia>(['letter', 'a4'])

export function isDocumentMediaCompatible(input: {
  documentType: PrintDocumentType
  format: PrintFormat
  media: PrintMedia
}) {
  if (input.documentType === 'shipping_label') {
    return SHIPPING_LABEL_MEDIA.has(input.media)
  }
  if (input.documentType === 'packing_slip') {
    return DOCUMENT_MEDIA.has(input.media) && input.format !== 'ZPL'
  }
  if (input.documentType === 'product_label' || input.documentType === 'location_label') {
    return LABEL_MEDIA.has(input.media) && input.format === 'ZPL'
  }
  return true
}

export function supportsPrintAgentRoute(
  capabilities: PrintAgentCapabilities,
  request: Pick<PrinterRouteRequest, 'documentType' | 'format' | 'media'>,
) {
  return capabilities.supportedFormats.includes(request.format)
    && capabilities.supportedMedia.includes(request.media)
    && capabilities.supportedDocumentTypes.includes(request.documentType)
}

export function hasConnectedLocalPrintAgent(
  printer: Pick<
    OperationsPrinterProfile,
    | 'connectionMode'
    | 'localPrintAgentGlobalId'
    | 'localPrintAgentStatus'
    | 'localPrintAgentLastSeenAt'
  >,
) {
  return printer.connectionMode === 'local_agent'
    && Boolean(printer.localPrintAgentGlobalId)
    && printer.localPrintAgentStatus === 'active'
    && Boolean(printer.localPrintAgentLastSeenAt)
}

export function isPrinterCapabilitySetValid(input: {
  printerType: PrinterType
  supportedFormats: PrintFormat[]
  supportedMedia: PrintMedia[]
}) {
  if (input.printerType === 'thermal') {
    return input.supportedMedia.every((media) => LABEL_MEDIA.has(media))
  }
  return input.supportedFormats.every((format) => format !== 'ZPL')
    && input.supportedMedia.every((media) => DOCUMENT_MEDIA.has(media))
}

export function supportsPrinterRoute(
  printer: OperationsPrinterProfile,
  request: PrinterRouteRequest,
) {
  if (
    printer.warehouseId !== request.warehouseId
    || printer.status === 'disabled'
    || !printer.supportedDocumentTypes.includes(request.documentType)
    || !printer.supportedFormats.includes(request.format)
    || !printer.supportedMedia.includes(request.media)
    || !isDocumentMediaCompatible(request)
    || (request.format === 'ZPL' && printer.printerType !== 'thermal')
  ) {
    return false
  }
  return !request.durable || hasConnectedLocalPrintAgent(printer)
}

export function printerCanFallbackFor(
  primary: OperationsPrinterProfile,
  fallback: OperationsPrinterProfile,
  request?: PrinterRouteRequest,
) {
  if (
    fallback.globalId === primary.globalId
    || fallback.warehouseId !== primary.warehouseId
    || fallback.status === 'disabled'
  ) {
    return false
  }
  if (request) return supportsPrinterRoute(fallback, request)
  return primary.supportedDocumentTypes.every((type) => (
    fallback.supportedDocumentTypes.includes(type)
  ))
    && primary.supportedFormats.every((format) => fallback.supportedFormats.includes(format))
    && primary.supportedMedia.every((media) => fallback.supportedMedia.includes(media))
}

function byPriority(left: OperationsPrinterProfile, right: OperationsPrinterProfile) {
  return left.priority - right.priority || left.name.localeCompare(right.name)
}

export function selectPrinterRoute(
  printers: OperationsPrinterProfile[],
  request: PrinterRouteRequest,
): PrinterRouteSelection | null {
  const candidates = printers.filter((printer) => supportsPrinterRoute(printer, request))
  const byGlobalId = new Map(candidates.map((printer) => [printer.globalId, printer]))
  const preferred = request.preferredPrinterGlobalId
    ? byGlobalId.get(request.preferredPrinterGlobalId)
    : null
  const defaults = candidates
    .filter((printer) => (
      printer.defaultDocumentTypes.includes(request.documentType)
      || printer.globalId === preferred?.globalId
    ))
    .sort((left, right) => (
      left.globalId === right.globalId
        ? 0
        : left.globalId === preferred?.globalId
          ? -1
          : right.globalId === preferred?.globalId
            ? 1
            : byPriority(left, right)
    ))

  for (const printer of defaults) {
    const fallback = printer.fallbackPrinterGlobalId
      ? byGlobalId.get(printer.fallbackPrinterGlobalId) || null
      : null
    if (printer.status === 'online') {
      return {
        printer,
        requestedPrinter: printer,
        fallbackPrinter: fallback,
        usedFallback: false,
        reason: printer.globalId === preferred?.globalId
          ? `${printer.name} was selected explicitly for this document`
          : `${printer.name} is the warehouse default for ${request.documentType}`,
      }
    }
    if (fallback?.status === 'online') {
      return {
        printer: fallback,
        requestedPrinter: printer,
        fallbackPrinter: fallback,
        usedFallback: true,
        reason: `${printer.name} is offline; routed to configured fallback ${fallback.name}`,
      }
    }
  }

  const available = candidates.filter((printer) => printer.status === 'online').sort(byPriority)
  if (!available[0]) return null
  const selected = available[0]
  const fallback = selected.fallbackPrinterGlobalId
    ? byGlobalId.get(selected.fallbackPrinterGlobalId) || null
    : null
  return {
    printer: selected,
    requestedPrinter: selected,
    fallbackPrinter: fallback,
    usedFallback: false,
    reason: `Selected the highest-priority compatible printer in ${selected.warehouseName}`,
  }
}
