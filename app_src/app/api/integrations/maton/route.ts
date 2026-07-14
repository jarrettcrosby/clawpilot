import { NextRequest, NextResponse } from 'next/server'
import {
  createUserMatonConnection,
  getMatonCredentialState,
  importPlatformMatonCredential,
  MatonCredentialRequestError,
  platformCredentialAvailable,
  refreshMatonConnections,
  revokeMatonCredential,
  selectUserMatonConnection,
  updateMatonCredential,
} from '@/lib/integrations/matonCredentials'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 64 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof MatonCredentialRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  return json({ ok: false, error: 'Maton integration request failed', code: 'MATON_INTERNAL_ERROR' }, 500)
}

function requirePostgresStorage() {
  if (!isPostgresStorageEnabled()) {
    throw new MatonCredentialRequestError(
      'Maton credentials require Postgres storage',
      503,
      'MATON_POSTGRES_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (contentLength > MAX_REQUEST_BYTES) {
    throw new MatonCredentialRequestError('Maton credential request is too large', 413, 'MATON_REQUEST_TOO_LARGE')
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new MatonCredentialRequestError('Maton credential request is too large', 413, 'MATON_REQUEST_TOO_LARGE')
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body was not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new MatonCredentialRequestError('Request body must be valid JSON', 400, 'MATON_REQUEST_INVALID')
  }
}

function requireOnlyFields(body: Record<string, unknown>, allowed: string[]) {
  const unsupported = Object.keys(body).find((key) => !allowed.includes(key))
  if (unsupported) throw new MatonCredentialRequestError(`Unsupported Maton action field: ${unsupported}`)
}

function credentialPayload(ownerEmail: string, credential: Awaited<ReturnType<typeof getMatonCredentialState>>) {
  return {
    credential,
    platformCredentialAvailable: platformCredentialAvailable(ownerEmail, credential),
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgresStorage()
    const credential = await getMatonCredentialState(actor.email)
    return json({ ok: true, ...credentialPayload(actor.email, credential) })
  } catch (error) {
    return errorResponse(error)
  }
}

async function updateRequest(req: NextRequest) {
  const actor = await requireRequestUser(req)
  requirePostgresStorage()
  const credential = await updateMatonCredential(actor.email, await requestBody(req))
  return json({ ok: true, ...credentialPayload(actor.email, credential) })
}

export async function PUT(req: NextRequest) {
  try {
    return await updateRequest(req)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgresStorage()
    const body = await requestBody(req)
    const action = typeof body.action === 'string' ? body.action : 'update-credential'

    if (action === 'update-credential') {
      const credential = await updateMatonCredential(actor.email, body)
      return json({ ok: true, ...credentialPayload(actor.email, credential) })
    }
    if (action === 'refresh-connections') {
      requireOnlyFields(body, ['action'])
      const credential = await refreshMatonConnections(actor.email)
      return json({ ok: true, ...credentialPayload(actor.email, credential) })
    }
    if (action === 'create-connection') {
      requireOnlyFields(body, ['action', 'app', 'name'])
      const result = await createUserMatonConnection(actor.email, body)
      return json({
        ok: true,
        ...credentialPayload(actor.email, result.credential),
        connection: result.connection,
        authorizationUrl: result.authorizationUrl,
      })
    }
    if (action === 'select-connection') {
      requireOnlyFields(body, ['action', 'connectionId'])
      const credential = await selectUserMatonConnection(actor.email, body.connectionId)
      return json({ ok: true, ...credentialPayload(actor.email, credential) })
    }
    if (action === 'import-platform-credential') {
      requireOnlyFields(body, ['action'])
      const credential = await importPlatformMatonCredential(actor.email)
      return json({ ok: true, ...credentialPayload(actor.email, credential) })
    }
    throw new MatonCredentialRequestError('Unsupported Maton action')
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgresStorage()
    const credential = await revokeMatonCredential(actor.email)
    return json({ ok: true, ...credentialPayload(actor.email, credential) })
  } catch (error) {
    return errorResponse(error)
  }
}
