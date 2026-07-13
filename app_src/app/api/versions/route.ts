import { NextRequest, NextResponse } from 'next/server'
import { requireRequestUser } from '@/lib/requestUser'
import { isHostedRuntime, isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  createDataCheckpoint,
  getReleaseOverview,
  getLocalReleaseOverview,
  releaseAccessFor,
  ReleasePermissionError,
  ReleaseRequestError,
} from '@/lib/releases'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Release request failed'

  if (message === 'Unauthorized' || message === 'User access is not active') {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (error instanceof ReleasePermissionError) {
    return NextResponse.json({ ok: false, error: message }, { status: 403 })
  }
  if (error instanceof ReleaseRequestError || error instanceof SyntaxError) {
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
  return NextResponse.json({ ok: false, error: 'Release request failed' }, { status: 500 })
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      if (isHostedRuntime()) throw new Error('Postgres storage is required in hosted environments')
      return NextResponse.json({ ok: true, ...getLocalReleaseOverview() })
    }
    const user = await requireRequestUser(req)
    return NextResponse.json({ ok: true, ...await getReleaseOverview(user) })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      throw new ReleaseRequestError('Data checkpoints require Postgres storage')
    }
    const user = await requireRequestUser(req)
    if (!releaseAccessFor(user).manageBackups) {
      throw new ReleasePermissionError('Data checkpoint management requires manageBackups access')
    }
    const checkpoint = await createDataCheckpoint(user, await req.json())
    return NextResponse.json({ ok: true, checkpoint }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
