import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  DEFAULT_PRINT_AGENT_CAPABILITIES,
  PRINT_DOCUMENT_TYPES,
  PRINT_FORMATS,
  PRINT_MEDIA,
  type PrintAgentCapabilities,
} from '@/lib/operations/printing'
import {
  enrollOperationsPrintAgentInPostgres,
  readOperationsPrintAgentWorkspaceFromPostgres,
  revokeOperationsPrintAgentInPostgres,
  rotateOperationsPrintAgentCredentialInPostgres,
} from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 8 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AGENT_GLOBAL_ID = /^gpt(?:[0-9]{7}|[0-9a-v]{12})$/
const ACTION_FIELDS: Record<string, Set<string>> = {
  'enroll-agent': new Set([
    'action',
    'warehouseId',
    'name',
    'supportedFormats',
    'supportedMedia',
    'supportedDocumentTypes',
  ]),
  'rotate-credential': new Set(['action', 'printAgentGlobalId']),
  'revoke-agent': new Set(['action', 'printAgentGlobalId']),
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    fail(
      'OPERATIONS_POSTGRES_REQUIRED',
      'Local print agents require Postgres storage',
      503,
    )
  }
}

function text(value: unknown, label: string, max: number) {
  const parsed = String(value ?? '').trim()
  if (!parsed || parsed.length > max || /[\u0000-\u001f\u007f]/.test(parsed)) {
    fail('OPERATIONS_PRINT_AGENT_REQUEST_INVALID', `${label} is invalid`)
  }
  return parsed
}

function capabilityList<T extends string>(
  value: unknown,
  label: string,
  supported: readonly T[],
) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > supported.length
  ) {
    fail('OPERATIONS_PRINT_AGENT_CAPABILITIES_INVALID', `${label} are invalid`)
  }
  const parsed = value.map((entry) => String(entry || '').trim() as T)
  if (
    parsed.some((entry) => !supported.includes(entry))
    || new Set(parsed).size !== parsed.length
  ) {
    fail('OPERATIONS_PRINT_AGENT_CAPABILITIES_INVALID', `${label} are invalid`)
  }
  return parsed
}

function enrollmentCapabilities(value: Record<string, unknown>): PrintAgentCapabilities {
  const fields = [
    value.supportedFormats,
    value.supportedMedia,
    value.supportedDocumentTypes,
  ]
  const provided = fields.filter((entry) => entry !== undefined).length
  if (provided === 0) {
    return {
      supportedFormats: [...DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats],
      supportedMedia: [...DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia],
      supportedDocumentTypes: [
        ...DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes,
      ],
    }
  }
  if (provided !== fields.length) {
    fail(
      'OPERATIONS_PRINT_AGENT_CAPABILITIES_INVALID',
      'Print-agent formats, media, and document types must be provided together',
    )
  }
  return {
    supportedFormats: capabilityList(
      value.supportedFormats,
      'Print-agent formats',
      PRINT_FORMATS,
    ),
    supportedMedia: capabilityList(
      value.supportedMedia,
      'Print-agent media',
      PRINT_MEDIA,
    ),
    supportedDocumentTypes: capabilityList(
      value.supportedDocumentTypes,
      'Print-agent document types',
      PRINT_DOCUMENT_TYPES,
    ),
  }
}

function idempotencyKey(req: NextRequest) {
  return text(req.headers.get('idempotency-key'), 'Idempotency-Key', 200)
}

async function body(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    fail(
      'OPERATIONS_PRINT_AGENT_CONTENT_TYPE_INVALID',
      'Print-agent commands require JSON',
      415,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_TOO_LARGE',
      'Print-agent command exceeded the supported size',
      413,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'A valid print-agent command is required',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'Print-agent command is invalid',
    )
  }
  const value = parsed as Record<string, unknown>
  const action = String(value.action || '')
  const supportedFields = ACTION_FIELDS[action]
  if (!supportedFields || Object.keys(value).some((field) => !supportedFields.has(field))) {
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'Print-agent command includes an unsupported action or field',
    )
  }
  return { action, value }
}

function agentGlobalId(value: unknown) {
  const globalId = text(value, 'Print agent Global ID', 16)
  if (!AGENT_GLOBAL_ID.test(globalId)) {
    fail('OPERATIONS_PRINT_AGENT_REQUEST_INVALID', 'Print agent Global ID is invalid')
  }
  return globalId
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
    error: 'Local print-agent request failed',
    code: 'OPERATIONS_PRINT_AGENT_REQUEST_FAILED',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const agents = await readOperationsPrintAgentWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      canView: capabilities.canView,
      canManage: capabilities.canManage,
    })
    return json({ ok: true, agents })
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
        error: 'You do not have permission to manage local print agents',
        code: 'OPERATIONS_PRINT_AGENT_MANAGE_REQUIRED',
      }, 403)
    }
    const command = await body(req)
    const organizationId = activeOperationsOrganizationId(actor)
    if (command.action === 'enroll-agent') {
      const warehouseId = text(command.value.warehouseId, 'Warehouse', 40)
      if (!UUID.test(warehouseId)) {
        fail('OPERATIONS_PRINT_AGENT_REQUEST_INVALID', 'Warehouse is invalid')
      }
      const capabilities = enrollmentCapabilities(command.value)
      const result = await enrollOperationsPrintAgentInPostgres({
        organizationId,
        warehouseId,
        name: text(command.value.name, 'Print agent name', 120),
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        ...capabilities,
      })
      return json({ ok: true, ...result })
    }
    if (command.action === 'rotate-credential') {
      const result = await rotateOperationsPrintAgentCredentialInPostgres({
        organizationId,
        printAgentGlobalId: agentGlobalId(command.value.printAgentGlobalId),
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
      })
      return json({ ok: true, ...result })
    }
    if (command.action === 'revoke-agent') {
      const agent = await revokeOperationsPrintAgentInPostgres({
        organizationId,
        printAgentGlobalId: agentGlobalId(command.value.printAgentGlobalId),
        actorEmail: actor.email,
      })
      return json({ ok: true, agent })
    }
    fail(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'Print-agent command action is invalid',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
