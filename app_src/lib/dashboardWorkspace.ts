import type { DashboardWorkspaceSnapshot } from '@/lib/dashboardBootstrapTypes'
import {
  listPipelineSpaces,
  listProjectBoards,
  readWorkspacePreferences,
} from '@/lib/tenancy'
import type { AppUser } from '@/lib/users'

type DashboardWorkspaceOptions = {
  requestedBoardId?: string
  requestedPipelineId?: string
  preferDefaults?: boolean
  ensureDefaults?: boolean
  compact?: boolean
}

export async function readDashboardWorkspace(
  actor: AppUser,
  options: DashboardWorkspaceOptions = {},
): Promise<DashboardWorkspaceSnapshot> {
  const [boards, pipelines, preferences] = await Promise.all([
    listProjectBoards(actor, { ensureDefaults: options.ensureDefaults !== false }),
    listPipelineSpaces(actor, { ensureDefaults: options.ensureDefaults !== false }),
    readWorkspacePreferences(actor),
  ])
  const defaultBoard = boards.find((board) => board.id === preferences.defaultBoardId)
    || boards.find((board) => board.ownerEmail === actor.email && board.isDefault)
    || boards[0]
  const defaultPipeline = pipelines.find((pipeline) => pipeline.id === preferences.defaultPipelineId)
    || pipelines.find((pipeline) => pipeline.ownerEmail === actor.email && pipeline.isDefault)
    || pipelines[0]
  const selectedBoard = options.preferDefaults
    ? defaultBoard
    : boards.find((board) => board.id === options.requestedBoardId) || defaultBoard
  const selectedPipeline = options.preferDefaults
    ? defaultPipeline
    : pipelines.find((pipeline) => pipeline.id === options.requestedPipelineId) || defaultPipeline

  const pipelineSummaries = pipelines.map((pipeline) => {
    const { projection, sheetId, shortLinkId, ...summary } = pipeline
    void projection
    void sheetId
    void shortLinkId
    return summary
  })

  return {
    boards: options.compact
      ? boards.map(({ id, name, ownerEmail, accessRole }) => ({ id, name, ownerEmail, accessRole }))
      : boards,
    pipelines: options.compact
      ? pipelineSummaries.map(({ id, name, ownerEmail, accessRole }) => ({ id, name, ownerEmail, accessRole }))
      : pipelineSummaries,
    selectedBoardId: selectedBoard?.id || null,
    selectedPipelineId: selectedPipeline?.id || null,
    defaultBoardId: defaultBoard?.id || null,
    defaultPipelineId: defaultPipeline?.id || null,
  }
}
