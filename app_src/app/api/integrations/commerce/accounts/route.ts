import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  readCommerceAccountDiscoveryFromPostgres,
} from '@/lib/persistence/commerceAccountDiscovery'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

class CommerceAccountDiscoveryRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'CommerceAccountDiscoveryRequestError'
    this.status = status
    this.code = code
  }
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function fail(code: string, message: string, status: number): never {
  throw new CommerceAccountDiscoveryRequestError(message, status, code)
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  const sanitized = error instanceof CommerceAccountDiscoveryRequestError
    ? error
    : new CommerceAccountDiscoveryRequestError(
      'Commerce-account discovery failed',
      500,
      'COMMERCE_ACCOUNT_DISCOVERY_FAILED',
    )
  return json(
    { ok: false, error: sanitized.message, code: sanitized.code },
    sanitized.status,
  )
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canManage) {
      fail(
        'COMMERCE_ACCOUNT_DISCOVERY_MANAGER_REQUIRED',
        'Operations-management permission is required',
        403,
      )
    }
    if (!isPostgresStorageEnabled()) {
      fail(
        'COMMERCE_ACCOUNT_DISCOVERY_POSTGRES_REQUIRED',
        'Commerce-account discovery requires Postgres storage',
        503,
      )
    }
    const organizationId = activeOperationsOrganizationId(actor)
    return json({
      ok: true,
      organizationId,
      accounts: await readCommerceAccountDiscoveryFromPostgres(
        organizationId,
      ),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
