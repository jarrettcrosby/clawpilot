import { NextRequest, NextResponse } from 'next/server'
import { requireRequestUser } from '@/lib/requestUser'
import {
  BOARD_SELECTION_COOKIE,
  PIPELINE_SELECTION_COOKIE,
  createPipelineSpace,
  createProjectBoard,
  listPipelineSpaces,
  listProjectBoards,
  removePipelineShare,
  removeProjectBoardShare,
  resolvePipelineSpaceAccess,
  resolveProjectBoardAccess,
  sharePipelineSpace,
  shareProjectBoard,
} from '@/lib/tenancy'

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
}

async function workspacePayload(actorEmail: string, req: NextRequest, selected?: { boardId?: string; pipelineId?: string }) {
  const [boards, pipelines] = await Promise.all([
    listProjectBoards(actorEmail),
    listPipelineSpaces(actorEmail),
  ])
  const requestedBoardId = selected?.boardId || req.cookies.get(BOARD_SELECTION_COOKIE)?.value || ''
  const requestedPipelineId = selected?.pipelineId || req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || ''
  const selectedBoard = boards.find((board) => board.id === requestedBoardId)
    || boards.find((board) => board.ownerEmail === actorEmail && board.isDefault)
    || boards[0]
  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === requestedPipelineId)
    || pipelines.find((pipeline) => pipeline.ownerEmail === actorEmail && pipeline.isDefault)
    || pipelines[0]

  return {
    ok: true,
    boards,
    pipelines: pipelines.map((pipeline) => {
      const { projection, ...summary } = pipeline
      void projection
      return summary
    }),
    selectedBoardId: selectedBoard?.id || null,
    selectedPipelineId: selectedPipeline?.id || null,
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Workspace request failed'
  const status = message === 'Unauthorized' ? 401 : /denied|view-only|Only the/i.test(message) ? 403 : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    return NextResponse.json(await workspacePayload(actor.email, req))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const body = await req.json()
    const action = String(body?.action || '')
    let selectedBoardId: string | undefined
    let selectedPipelineId: string | undefined

    if (action === 'create-board') {
      selectedBoardId = (await createProjectBoard({ actorEmail: actor.email, name: body?.name })).id
    } else if (action === 'create-pipeline') {
      selectedPipelineId = (await createPipelineSpace({ actorEmail: actor.email, name: body?.name })).id
    } else if (action === 'select-board') {
      selectedBoardId = (await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: body?.boardId })).id
    } else if (action === 'select-pipeline') {
      selectedPipelineId = (await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: body?.pipelineId })).id
    } else if (action === 'share-board') {
      await shareProjectBoard({
        actorEmail: actor.email,
        boardId: body?.boardId,
        userEmail: body?.email,
        accessRole: body?.accessRole,
      })
    } else if (action === 'share-pipeline') {
      await sharePipelineSpace({
        actorEmail: actor.email,
        pipelineId: body?.pipelineId,
        userEmail: body?.email,
        accessRole: body?.accessRole,
      })
    } else if (action === 'remove-board-share') {
      await removeProjectBoardShare({ actorEmail: actor.email, boardId: body?.boardId, userEmail: body?.email })
    } else if (action === 'remove-pipeline-share') {
      await removePipelineShare({ actorEmail: actor.email, pipelineId: body?.pipelineId, userEmail: body?.email })
    } else {
      return NextResponse.json({ ok: false, error: 'Unsupported workspace action' }, { status: 400 })
    }

    const response = NextResponse.json(await workspacePayload(actor.email, req, {
      boardId: selectedBoardId,
      pipelineId: selectedPipelineId,
    }))
    if (selectedBoardId) response.cookies.set(BOARD_SELECTION_COOKIE, selectedBoardId, COOKIE_OPTIONS)
    if (selectedPipelineId) response.cookies.set(PIPELINE_SELECTION_COOKIE, selectedPipelineId, COOKIE_OPTIONS)
    return response
  } catch (error) {
    return errorResponse(error)
  }
}
