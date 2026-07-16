import { NextRequest, NextResponse } from 'next/server'
import {
  generateUserDocument,
  type GeneratedDocumentKind,
} from '@/lib/documents'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const DOCUMENT_KINDS = new Set<GeneratedDocumentKind>([
  'build-brief',
  'project-report',
  'pipeline-report',
  'research-radar',
])

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return NextResponse.json({ ok: false, error: 'Generated documents require Postgres storage' }, { status: 409 })
    }
    const actor = await requireRequestUser(req)
    const body = await req.json()
    const kind = String(body?.kind || '') as GeneratedDocumentKind
    if (!DOCUMENT_KINDS.has(kind)) {
      return NextResponse.json({ ok: false, error: 'Select a document type' }, { status: 400 })
    }
    const document = await generateUserDocument({
      user: actor,
      kind,
      boardId: body?.boardId,
      pipelineId: body?.pipelineId,
    })
    return NextResponse.json({ ok: true, document }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document generation failed'
    const status = message === 'Unauthorized'
      ? 401
      : /access denied|view-only/i.test(message)
        ? 403
        : 400
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
