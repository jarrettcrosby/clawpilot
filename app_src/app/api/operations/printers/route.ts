import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  PRINT_DOCUMENT_TYPES,
  PRINT_FORMATS,
  PRINT_MEDIA,
  PRINTER_CONNECTION_MODES,
  PRINTER_STATUSES,
  PRINTER_STATION_TYPES,
  PRINTER_TYPES,
  isPrinterCapabilitySetValid,
  type OperationsPrinterInput,
} from '@/lib/operations/printing'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readOperationsPrinterWorkspaceFromPostgres,
  saveOperationsPrinterInPostgres,
} from '@/lib/persistence/operationPrinting'
import { OperationsRequestError } from '@/lib/persistence/operations'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 16 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRINTER_GLOBAL_ID = /^gpr\d{7}$/
const PRINT_AGENT_GLOBAL_ID = /^gpt\d{7}$/
const SAVE_FIELDS = new Set([
  'action',
  'globalId',
  'expectedRowVersion',
  'warehouseId',
  'code',
  'name',
  'stationType',
  'printerType',
  'connectionMode',
  'supportedFormats',
  'supportedMedia',
  'supportedDocumentTypes',
  'defaultDocumentTypes',
  'fallbackPrinterGlobalId',
  'localPrintAgentGlobalId',
  'priority',
  'status',
])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError(
      'OPERATIONS_POSTGRES_REQUIRED',
      'Printer configuration requires Postgres storage',
      503,
    )
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', 'Printer command is invalid')
  }
  return value as Record<string, unknown>
}

function textValue(value: unknown, label: string, max: number) {
  const text = String(value ?? '').trim()
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function enumValue<T extends string>(
  value: unknown,
  label: string,
  supported: readonly T[],
): T {
  const parsed = textValue(value, label, 50) as T
  if (!supported.includes(parsed)) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', `${label} is invalid`)
  }
  return parsed
}

function listValue<T extends string>(
  value: unknown,
  label: string,
  supported: readonly T[],
  allowEmpty = false,
): T[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > supported.length) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', `${label} is invalid`)
  }
  const values = value.map((entry) => enumValue(entry, label, supported))
  if (new Set(values).size !== values.length) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', `${label} includes duplicates`)
  }
  return values
}

function optionalPrinterGlobalId(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const globalId = textValue(value, 'Fallback printer', 16)
  if (!PRINTER_GLOBAL_ID.test(globalId)) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', 'Fallback printer is invalid')
  }
  return globalId
}

function optionalPrintAgentGlobalId(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const globalId = textValue(value, 'Local print agent', 16)
  if (!PRINT_AGENT_GLOBAL_ID.test(globalId)) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', 'Local print agent is invalid')
  }
  return globalId
}

function printerInput(value: unknown): OperationsPrinterInput {
  const input = record(value)
  const unsupported = Object.keys(input).find((field) => !SAVE_FIELDS.has(field))
  if (unsupported) {
    requestError(
      'OPERATIONS_PRINTER_REQUEST_INVALID',
      'Printer command includes an unsupported field',
    )
  }
  if (input.action !== 'save-printer') {
    requestError('OPERATIONS_PRINTER_ACTION_INVALID', 'Printer action is invalid')
  }
  const globalId = input.globalId === undefined
    ? undefined
    : textValue(input.globalId, 'Printer Global ID', 16)
  if (globalId && !PRINTER_GLOBAL_ID.test(globalId)) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', 'Printer Global ID is invalid')
  }
  const expectedRowVersion = globalId ? Number(input.expectedRowVersion) : undefined
  if (
    globalId
    && (!Number.isSafeInteger(expectedRowVersion) || Number(expectedRowVersion) < 0)
  ) {
    requestError(
      'OPERATIONS_PRINTER_REQUEST_INVALID',
      'Printer version is invalid',
    )
  }
  const warehouseId = textValue(input.warehouseId, 'Warehouse', 40)
  if (!UUID.test(warehouseId)) {
    requestError('OPERATIONS_PRINTER_REQUEST_INVALID', 'Warehouse is invalid')
  }
  const code = textValue(input.code, 'Printer code', 40).toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(code)) {
    requestError(
      'OPERATIONS_PRINTER_REQUEST_INVALID',
      'Printer code must use letters, numbers, periods, underscores, or hyphens',
    )
  }
  const supportedDocumentTypes = listValue(
    input.supportedDocumentTypes,
    'Supported documents',
    PRINT_DOCUMENT_TYPES,
  )
  const defaultDocumentTypes = listValue(
    input.defaultDocumentTypes,
    'Default documents',
    PRINT_DOCUMENT_TYPES,
    true,
  )
  if (defaultDocumentTypes.some((type) => !supportedDocumentTypes.includes(type))) {
    requestError(
      'OPERATIONS_PRINTER_REQUEST_INVALID',
      'Default documents must also be supported by the printer',
    )
  }
  const priority = Number(input.priority)
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 999) {
    requestError(
      'OPERATIONS_PRINTER_REQUEST_INVALID',
      'Printer priority must be an integer from 1 to 999',
    )
  }
  const printerType = enumValue(input.printerType, 'Printer type', PRINTER_TYPES)
  const connectionMode = enumValue(
    input.connectionMode,
    'Connection mode',
    PRINTER_CONNECTION_MODES,
  )
  const supportedFormats = listValue(input.supportedFormats, 'Print formats', PRINT_FORMATS)
  const supportedMedia = listValue(input.supportedMedia, 'Print media', PRINT_MEDIA)
  const localPrintAgentGlobalId = optionalPrintAgentGlobalId(input.localPrintAgentGlobalId)
  const status = enumValue(input.status, 'Printer status', PRINTER_STATUSES)
  if (!isPrinterCapabilitySetValid({ printerType, supportedFormats, supportedMedia })) {
    requestError(
      'OPERATIONS_PRINTER_CAPABILITIES_INVALID',
      printerType === 'thermal'
        ? 'Thermal printers must use 4 x 6 or 4 x 8 label media'
        : 'Nonthermal printers must use PDF or PNG on Letter or A4 media',
    )
  }
  if (localPrintAgentGlobalId && connectionMode !== 'local_agent') {
    requestError(
      'OPERATIONS_PRINTER_AGENT_INVALID',
      'Only local-agent printer profiles can be assigned to a print agent',
    )
  }
  if (connectionMode === 'local_agent' && status === 'online' && !localPrintAgentGlobalId) {
    requestError(
      'OPERATIONS_PRINTER_AGENT_REQUIRED',
      'Assign an active local print agent before marking this printer online',
    )
  }
  return {
    globalId,
    expectedRowVersion,
    warehouseId,
    code,
    name: textValue(input.name, 'Printer name', 120),
    stationType: enumValue(input.stationType, 'Station type', PRINTER_STATION_TYPES),
    printerType,
    connectionMode,
    supportedFormats,
    supportedMedia,
    supportedDocumentTypes,
    defaultDocumentTypes,
    fallbackPrinterGlobalId: optionalPrinterGlobalId(input.fallbackPrinterGlobalId),
    localPrintAgentGlobalId,
    priority,
    status,
  }
}

async function requestBody(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    requestError(
      'OPERATIONS_PRINTER_CONTENT_TYPE_INVALID',
      'Printer commands require JSON',
      415,
    )
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_PRINTER_REQUEST_TOO_LARGE',
      'Printer command exceeded the supported size',
      413,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_PRINTER_REQUEST_TOO_LARGE',
      'Printer command exceeded the supported size',
      413,
    )
  }
  try {
    return printerInput(JSON.parse(raw) as unknown)
  } catch (error) {
    if (error instanceof OperationsRequestError) throw error
    requestError(
      'OPERATIONS_PRINTER_REQUEST_INVALID',
      'A valid printer command is required',
    )
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an active organization first',
      code: error.message,
    }, 409)
  }
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  return json({
    ok: false,
    error: 'Printer configuration request failed',
    code: 'OPERATIONS_PRINTER_REQUEST_FAILED',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const printers = await readOperationsPrinterWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      canView: capabilities.canView,
      canManage: capabilities.canManage,
      canExecute: capabilities.canExecute,
    })
    return json({ ok: true, printers })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) {
      return json({
        ok: false,
        error: 'You do not have permission to manage printer configuration',
        code: 'OPERATIONS_PRINTER_MANAGE_REQUIRED',
      }, 403)
    }
    const printer = await requestBody(req)
    const saved = await saveOperationsPrinterInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      actorEmail: actor.email,
      printer,
    })
    return json({ ok: true, printer: saved })
  } catch (error) {
    return errorResponse(error)
  }
}
