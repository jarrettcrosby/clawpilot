import { NextRequest, NextResponse } from 'next/server'
import { requireRequestUser } from '@/lib/requestUser'
import {
  PipelineProvisioningRequestError,
  queuePipelineProvisioning,
} from '@/lib/pipelineProvisioning'
import {
  BOARD_SELECTION_COOKIE,
  PIPELINE_SELECTION_COOKIE,
  createPipelineSpace,
  createProjectBoard,
  listPipelineSpaces,
  listProjectBoards,
  readWorkspacePreferences,
  removePipelineShare,
  removeProjectBoardShare,
  resolvePipelineSpaceAccess,
  resolveProjectBoardAccess,
  sharePipelineSpace,
  shareProjectBoard,
  saveWorkspacePreferences,
} from '@/lib/tenancy'

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 365,
}

async function workspacePayload(
  actorEmail: string,
  req: NextRequest,
  selected?: { boardId?: string; pipelineId?: string },
  preferDefaults = false,
) {
  const [boards, pipelines, preferences] = await Promise.all([
    listProjectBoards(actorEmail),
    listPipelineSpaces(actorEmail),
    readWorkspacePreferences(actorEmail),
  ])
  const requestedBoardId = selected?.boardId || req.cookies.get(BOARD_SELECTION_COOKIE)?.value || ''
  const requestedPipelineId = selected?.pipelineId || req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || ''
  const defaultBoard = boards.find((board) => board.id === preferences.defaultBoardId)
    || boards.find((board) => board.ownerEmail === actorEmail && board.isDefault)
    || boards[0]
  const defaultPipeline = pipelines.find((pipeline) => pipeline.id === preferences.defaultPipelineId)
    || pipelines.find((pipeline) => pipeline.ownerEmail === actorEmail && pipeline.isDefault)
    || pipelines[0]
  const selectedBoard = preferDefaults
    ? defaultBoard
    : boards.find((board) => board.id === requestedBoardId) || defaultBoard
  const selectedPipeline = preferDefaults
    ? defaultPipeline
    : pipelines.find((pipeline) => pipeline.id === requestedPipelineId) || defaultPipeline

  return {
    ok: true,
    boards,
    pipelines: pipelines.map((pipeline) => {
      const { projection, sheetId, shortLinkId, ...summary } = pipeline
      void projection
      void sheetId
      void shortLinkId
      return summary
    }),
    selectedBoardId: selectedBoard?.id || null,
    selectedPipelineId: selectedPipeline?.id || null,
    defaultBoardId: defaultBoard?.id || null,
    defaultPipelineId: defaultPipeline?.id || null,
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Workspace request failed'
  const status = error instanceof PipelineProvisioningRequestError
    ? error.status
    : message === 'Unauthorized'
      ? 401
      : /denied|view-only|Only the/i.test(message)
        ? 403
        : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const dashboard = req.nextUrl.searchParams.get('dashboard') === 'true'
    const payload = await workspacePayload(actor.email, req, undefined, dashboard)
    const response = NextResponse.json(payload)
    if (dashboard && payload.selectedBoardId) {
      response.cookies.set(BOARD_SELECTION_COOKIE, payload.selectedBoardId, COOKIE_OPTIONS)
    }
    if (dashboard && payload.selectedPipelineId) {
      response.cookies.set(PIPELINE_SELECTION_COOKIE, payload.selectedPipelineId, COOKIE_OPTIONS)
    }
    return response
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
    let actionResult: Record<string, unknown> | undefined

    if (action === 'create-board') {
      selectedBoardId = (await createProjectBoard({ actorEmail: actor.email, name: body?.name })).id
    } else if (action === 'create-pipeline') {
      selectedPipelineId = (await createPipelineSpace({ actorEmail: actor.email, name: body?.name })).id
    } else if (action === 'select-board') {
      selectedBoardId = (await resolveProjectBoardAccess({ actorEmail: actor.email, boardId: body?.boardId })).id
    } else if (action === 'select-pipeline') {
      selectedPipelineId = (await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: body?.pipelineId })).id
    } else if (action === 'provision-pipeline') {
      const unsupported = Object.keys(body || {}).find((field) => !['action', 'pipelineId'].includes(field))
      if (unsupported) {
        throw new PipelineProvisioningRequestError(
          'Managed Google resource and credential fields are selected by ClawPilot',
          400,
          'PIPELINE_PROVISIONING_FIELDS_INVALID',
        )
      }
      const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor.email, pipelineId: body?.pipelineId })
      if (pipeline.ownerEmail !== actor.email || pipeline.accessRole !== 'owner') {
        throw new PipelineProvisioningRequestError('Only the pipeline owner can provision it', 403)
      }
      actionResult = await queuePipelineProvisioning({ actorEmail: actor.email, pipelineId: pipeline.id })
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

    if (body?.setDefault === true && (selectedBoardId || selectedPipelineId)) {
      await saveWorkspacePreferences({
        actorEmail: actor.email,
        ...(selectedBoardId ? { boardId: selectedBoardId } : {}),
        ...(selectedPipelineId ? { pipelineId: selectedPipelineId } : {}),
      })
    }

    const payload = await workspacePayload(actor.email, req, {
      boardId: selectedBoardId,
      pipelineId: selectedPipelineId,
    })
    const response = NextResponse.json(actionResult ? { ...payload, actionResult } : payload)
    if (selectedBoardId) response.cookies.set(BOARD_SELECTION_COOKIE, selectedBoardId, COOKIE_OPTIONS)
    if (selectedPipelineId) response.cookies.set(PIPELINE_SELECTION_COOKIE, selectedPipelineId, COOKIE_OPTIONS)
    return response
  } catch (error) {
    return errorResponse(error)
  }
}
