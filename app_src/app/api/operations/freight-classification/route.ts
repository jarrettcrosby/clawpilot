import { NextRequest, NextResponse } from 'next/server'

import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { calculateLtlDensityClassification } from '@/lib/operations/freightClassification'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  attestLtlFreightClassificationInPostgres,
  LtlFreightClassificationPersistenceError,
} from '@/lib/persistence/ltlFreightClassification'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 64 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof LtlFreightClassificationPersistenceError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (
    error instanceof Error
    && error.message.startsWith('LTL_FREIGHT_CLASSIFICATION_INVALID:')
  ) {
    return json({
      ok: false,
      error: error.message,
      code: 'LTL_CLASSIFICATION_INPUT_INVALID',
    }, 400)
  }
  console.error('[operations-freight-classification] request failure', {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return json({
    ok: false,
    error: 'Freight classification request failed',
    code: 'LTL_CLASSIFICATION_REQUEST_FAILED',
  }, 500)
}

async function body(req: NextRequest) {
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_REQUEST_TOO_LARGE',
      'Freight classification request is too large',
      413,
    )
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_REQUEST_INVALID',
      'Freight classification request must be valid JSON',
    )
  }
}

function only(value: Record<string, unknown>, keys: string[]) {
  const unexpected = Object.keys(value).find((key) => !keys.includes(key))
  if (unexpected) {
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_REQUEST_INVALID',
      `Unexpected freight classification field: ${unexpected}`,
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage || !capabilities.canExecute) {
      return json({
        ok: false,
        error: 'Operations management and warehouse execution permission are required',
        code: 'LTL_CLASSIFICATION_PERMISSION_REQUIRED',
      }, 403)
    }
    const request = await body(req)
    const action = String(request.action || '').trim()
    if (action === 'calculate-density') {
      only(request, ['action', 'assessment'])
      return json({
        ok: true,
        assessment: calculateLtlDensityClassification(request.assessment),
      })
    }
    if (action === 'attest-density') {
      only(request, ['action', 'assessment', 'attestation'])
      if (!isPostgresStorageEnabled()) {
        throw new LtlFreightClassificationPersistenceError(
          'OPERATIONS_POSTGRES_REQUIRED',
          'Saving freight classification evidence requires Postgres storage',
          503,
        )
      }
      const result = await attestLtlFreightClassificationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        idempotencyKey: req.headers.get('idempotency-key'),
        assessment: request.assessment,
        attestation: request.attestation,
      })
      return json({ ok: true, result }, result.replayed ? 200 : 201)
    }
    throw new LtlFreightClassificationPersistenceError(
      'LTL_CLASSIFICATION_ACTION_UNSUPPORTED',
      'Unsupported freight classification action',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
