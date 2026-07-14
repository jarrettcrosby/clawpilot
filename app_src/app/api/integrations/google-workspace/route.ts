import { NextRequest, NextResponse } from 'next/server'
import {
  disconnectGoogleWorkspaceIntegration,
  getGoogleWorkspaceIntegrationState,
  GoogleWorkspaceRequestError,
  refreshGoogleWorkspaceSharedDrives,
  sanitizedGoogleWorkspaceError,
  selectGoogleWorkspaceSharedDrive,
  testGoogleWorkspaceConnection,
  updateGoogleWorkspaceCredential,
} from '@/lib/integrations/googleWorkspace'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 96 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof GoogleWorkspaceRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  const sanitized = sanitizedGoogleWorkspaceError(error)
  return json({ ok: false, error: sanitized.message, code: sanitized.code }, sanitized.status)
}

function requirePostgresStorage() {
  if (!isPostgresStorageEnabled()) {
    throw new GoogleWorkspaceRequestError(
      'Google Workspace integration requires Postgres storage',
      503,
      'GOOGLE_WORKSPACE_POSTGRES_REQUIRED',
    )
  }
}

async function requireOwner(req: NextRequest) {
  const actor = await requireRequestUser(req)
  if (actor.role !== 'owner') {
    throw new GoogleWorkspaceRequestError(
      'Only the ClawPilot owner can manage the platform Google Workspace integration',
      403,
      'GOOGLE_WORKSPACE_OWNER_REQUIRED',
    )
  }
  requirePostgresStorage()
  return actor
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new GoogleWorkspaceRequestError(
      'Google Workspace integration request is too large',
      413,
      'GOOGLE_WORKSPACE_REQUEST_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new GoogleWorkspaceRequestError(
      'Google Workspace integration request is too large',
      413,
      'GOOGLE_WORKSPACE_REQUEST_TOO_LARGE',
    )
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new GoogleWorkspaceRequestError(
      'Request body must be a valid JSON object',
      400,
      'GOOGLE_WORKSPACE_REQUEST_INVALID',
    )
  }
}

function requireOnlyFields(body: Record<string, unknown>, allowed: string[]) {
  const unsupported = Object.keys(body).find((field) => !allowed.includes(field))
  if (unsupported) {
    throw new GoogleWorkspaceRequestError(
      `Unsupported Google Workspace action field: ${unsupported}`,
      400,
      'GOOGLE_WORKSPACE_REQUEST_INVALID',
    )
  }
}

function action(body: Record<string, unknown>) {
  if (typeof body.action !== 'string' || !body.action.trim()) {
    throw new GoogleWorkspaceRequestError(
      'A Google Workspace action is required',
      400,
      'GOOGLE_WORKSPACE_ACTION_REQUIRED',
    )
  }
  return body.action.trim()
}

export async function GET(req: NextRequest) {
  try {
    await requireOwner(req)
    return json({ ok: true, integration: await getGoogleWorkspaceIntegrationState() })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireOwner(req)
    const body = await requestBody(req)
    const requestedAction = action(body)

    if (requestedAction === 'update-credential') {
      requireOnlyFields(body, ['action', 'apiKey', 'serviceAccountJson'])
      const setApiKey = Object.hasOwn(body, 'apiKey')
      const setServiceAccount = Object.hasOwn(body, 'serviceAccountJson')
      const integration = await updateGoogleWorkspaceCredential({
        actorEmail: actor.email,
        apiKey: body.apiKey,
        serviceAccountJson: body.serviceAccountJson,
        setApiKey,
        setServiceAccount,
      })
      return json({ ok: true, integration })
    }
    if (requestedAction === 'refresh-shared-drives') {
      requireOnlyFields(body, ['action'])
      const result = await refreshGoogleWorkspaceSharedDrives({ actorEmail: actor.email })
      return json({ ok: true, integration: result.integration, sharedDrives: result.sharedDrives })
    }
    if (requestedAction === 'select-shared-drive') {
      requireOnlyFields(body, ['action', 'sharedDriveId'])
      if (!Object.hasOwn(body, 'sharedDriveId')) {
        throw new GoogleWorkspaceRequestError(
          'sharedDriveId is required',
          400,
          'GOOGLE_SHARED_DRIVE_REQUIRED',
        )
      }
      const integration = await selectGoogleWorkspaceSharedDrive({
        actorEmail: actor.email,
        sharedDriveId: body.sharedDriveId,
      })
      return json({ ok: true, integration })
    }
    if (requestedAction === 'test-connection') {
      requireOnlyFields(body, ['action'])
      const integration = await testGoogleWorkspaceConnection({ actorEmail: actor.email })
      return json({ ok: true, integration })
    }
    if (requestedAction === 'disconnect') {
      requireOnlyFields(body, ['action'])
      const integration = await disconnectGoogleWorkspaceIntegration({ actorEmail: actor.email })
      return json({ ok: true, integration })
    }
    throw new GoogleWorkspaceRequestError(
      'Unsupported Google Workspace action',
      400,
      'GOOGLE_WORKSPACE_ACTION_INVALID',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const actor = await requireOwner(req)
    const integration = await disconnectGoogleWorkspaceIntegration({ actorEmail: actor.email })
    return json({ ok: true, integration })
  } catch (error) {
    return errorResponse(error)
  }
}
