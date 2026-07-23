import { NextRequest, NextResponse } from 'next/server'
import { validateGlCodingConditions } from '@/lib/operations/glCoding'
import {
  activeOperationsOrganizationId,
  carrierRateNetworkCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  assignGlCodingOrphanInPostgres,
  createGlCodingRuleInPostgres,
  GlCodingRequestError,
  readGlCodingWorkspaceFromPostgres,
  runSelectedGlCodingFilesInPostgres,
} from '@/lib/persistence/glCoding'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024
const BILLING_BATCH_GLOBAL_ID = /^gcb\d{7}$/
const BILLING_CHARGE_GLOBAL_ID = /^gcl\d{7}$/
const RATE_PARTY_GLOBAL_ID = /^grp\d{7}$/

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
  throw new GlCodingRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError('GL_CODING_POSTGRES_REQUIRED', 'GL Coding requires Postgres storage', 503)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError('GL_CODING_REQUEST_INVALID', `${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function assertFields(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  const unsupported = Object.keys(value).find((field) => !allowed.has(field))
  if (unsupported) {
    requestError('GL_CODING_REQUEST_INVALID', `${label} includes an unsupported field`)
  }
}

function textValue(value: unknown, label: string, max: number, required = true): string {
  const text = String(value ?? '').trim()
  if (
    (required && !text)
    || text.length > max
    || /[\u0000-\u001f\u007f]/.test(text)
  ) {
    requestError('GL_CODING_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    requestError(
      'GL_CODING_REQUEST_INVALID',
      `${label} must be an integer from ${minimum} to ${maximum}`,
    )
  }
  return parsed
}

function globalIdValue(value: unknown, label: string, pattern: RegExp): string {
  const globalId = textValue(value, label, 16)
  if (!pattern.test(globalId)) {
    requestError('GL_CODING_REQUEST_INVALID', `${label} is invalid`)
  }
  return globalId
}

function idempotencyKeyValue(req: NextRequest): string {
  const key = String(req.headers.get('idempotency-key') || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    requestError(
      'GL_CODING_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return key
}

function validateJsonOutputValue(value: unknown, depth = 0): void {
  if (depth > 3) requestError('GL_CODING_RULE_OUTPUTS_INVALID', 'Rule outputs are too deeply nested')
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      requestError('GL_CODING_RULE_OUTPUTS_INVALID', 'Rule outputs include an invalid number')
    }
    if (typeof value === 'string' && value.length > 500) {
      requestError('GL_CODING_RULE_OUTPUTS_INVALID', 'Rule output text is too long')
    }
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 50) requestError('GL_CODING_RULE_OUTPUTS_INVALID', 'Rule output list is too long')
    value.forEach((entry) => validateJsonOutputValue(entry, depth + 1))
    return
  }
  if (!value || typeof value !== 'object') {
    requestError('GL_CODING_RULE_OUTPUTS_INVALID', 'Rule outputs include an unsupported value')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 25) requestError('GL_CODING_RULE_OUTPUTS_INVALID', 'Rule outputs include too many fields')
  for (const [key, nested] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key)) {
      requestError('GL_CODING_RULE_OUTPUTS_INVALID', 'Rule output field is invalid')
    }
    validateJsonOutputValue(nested, depth + 1)
  }
}

function outputsValue(value: unknown): Record<string, unknown> {
  const outputs = record(value ?? {}, 'Rule outputs')
  validateJsonOutputValue(outputs)
  if (Buffer.byteLength(JSON.stringify(outputs), 'utf8') > 8 * 1024) {
    requestError('GL_CODING_RULE_OUTPUTS_INVALID', 'Rule outputs exceed the supported size')
  }
  return outputs
}

function conditionsValue(value: unknown) {
  try {
    return validateGlCodingConditions(value)
  } catch {
    requestError(
      'GL_CODING_RULE_CONDITIONS_INVALID',
      'Rule conditions include an unsupported field, operator, or value',
    )
  }
}

function effectiveFromValue(value: unknown): string {
  const raw = textValue(value, 'Effective date', 50)
  const date = new Date(raw)
  const now = Date.now()
  const tenYears = 10 * 366 * 24 * 60 * 60 * 1000
  if (
    Number.isNaN(date.getTime())
    || date.getTime() < now - tenYears
    || date.getTime() > now + tenYears
  ) {
    requestError('GL_CODING_REQUEST_INVALID', 'Effective date is outside the supported range')
  }
  return date.toISOString()
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    requestError('GL_CODING_CONTENT_TYPE_INVALID', 'GL Coding commands require JSON', 415)
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError('GL_CODING_REQUEST_TOO_LARGE', 'GL Coding command exceeded the supported size', 413)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError('GL_CODING_REQUEST_TOO_LARGE', 'GL Coding command exceeded the supported size', 413)
  }
  try {
    return record(JSON.parse(raw) as unknown, 'GL Coding command')
  } catch (error) {
    if (error instanceof GlCodingRequestError) throw error
    requestError('GL_CODING_REQUEST_INVALID', 'A valid GL Coding command is required')
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
  if (error instanceof GlCodingRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  const code = error instanceof Error && /^CARRIER_RATE_NETWORK_[A-Z_]+$/.test(error.message)
    ? error.message
    : 'GL_CODING_REQUEST_FAILED'
  const status = code === 'CARRIER_RATE_NETWORK_FORBIDDEN' ? 403 : 500
  return json({
    ok: false,
    error: status === 500 ? 'GL Coding request failed' : 'You do not have permission to manage GL Coding',
    code,
  }, status)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = carrierRateNetworkCapabilities(actor)
    if (!capabilities.canViewCarrierCost && !capabilities.canReconcileCarrierBilling) {
      return json({
        ok: false,
        error: 'You do not have permission to view carrier billing',
        code: 'CARRIER_BILLING_VIEW_REQUIRED',
      }, 403)
    }
    const glCoding = await readGlCodingWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      capabilities,
    })
    return json({ ok: true, glCoding })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = carrierRateNetworkCapabilities(actor)
    if (!capabilities.canReconcileCarrierBilling) {
      return json({
        ok: false,
        error: 'You do not have permission to reconcile carrier billing',
        code: 'CARRIER_BILLING_RECONCILE_REQUIRED',
      }, 403)
    }
    const body = await requestBody(req)
    const action = textValue(body.action, 'GL Coding action', 50)
    if (action === 'run-selected-files') {
      assertFields(body, new Set(['action', 'batchGlobalIds']), 'GL Coding command')
      if (!Array.isArray(body.batchGlobalIds)) {
        requestError('GL_CODING_REQUEST_INVALID', 'Select at least one carrier billing file')
      }
      const batchGlobalIds = Array.from(new Set(body.batchGlobalIds.map((value) => (
        globalIdValue(value, 'Carrier billing file', BILLING_BATCH_GLOBAL_ID)
      ))))
      if (batchGlobalIds.length < 1 || batchGlobalIds.length > 50) {
        requestError('GL_CODING_REQUEST_INVALID', 'Select from 1 to 50 carrier billing files')
      }
      const result = await runSelectedGlCodingFilesInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        batchGlobalIds,
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result }, result.duplicate ? 200 : 201)
    }
    if (action === 'assign-orphan') {
      assertFields(
        body,
        new Set(['action', 'chargeGlobalId', 'shipperPartyGlobalId', 'reason']),
        'GL Coding command',
      )
      const result = await assignGlCodingOrphanInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        chargeGlobalId: globalIdValue(
          body.chargeGlobalId,
          'Carrier billing charge',
          BILLING_CHARGE_GLOBAL_ID,
        ),
        shipperPartyGlobalId: globalIdValue(
          body.shipperPartyGlobalId,
          'Shipper',
          RATE_PARTY_GLOBAL_ID,
        ),
        reason: textValue(body.reason, 'Assignment reason', 500),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result }, result.duplicate ? 200 : 201)
    }
    if (action === 'create-rule') {
      if (!capabilities.canManageNetworks) {
        return json({
          ok: false,
          error: 'Network management permission is required to change GL Coding rules',
          code: 'CARRIER_RATE_NETWORK_MANAGE_REQUIRED',
        }, 403)
      }
      assertFields(
        body,
        new Set([
          'action',
          'name',
          'priority',
          'matchMode',
          'conditions',
          'outputs',
          'targetShipperPartyGlobalId',
          'effectiveFrom',
        ]),
        'GL Coding command',
      )
      const matchMode = textValue(body.matchMode, 'Rule match mode', 10)
      if (matchMode !== 'all' && matchMode !== 'any') {
        requestError('GL_CODING_REQUEST_INVALID', 'Rule match mode is invalid')
      }
      const result = await createGlCodingRuleInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        name: textValue(body.name, 'Rule name', 120),
        priority: integerValue(body.priority, 'Rule priority', 1, 1_000_000),
        matchMode,
        conditions: conditionsValue(body.conditions),
        outputs: outputsValue(body.outputs),
        targetShipperPartyGlobalId: globalIdValue(
          body.targetShipperPartyGlobalId,
          'Target shipper',
          RATE_PARTY_GLOBAL_ID,
        ),
        effectiveFrom: effectiveFromValue(body.effectiveFrom),
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({ ok: true, capabilities, result }, result.duplicate ? 200 : 201)
    }
    requestError('GL_CODING_ACTION_INVALID', 'GL Coding action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}
