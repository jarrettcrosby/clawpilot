import type {
  DashboardBootstrapPayload,
  DashboardDocMeta,
  DashboardPipelineSnapshot,
} from '@/lib/dashboardBootstrapTypes'
import { readDashboardWorkspace } from '@/lib/dashboardWorkspace'
import { ensureApplicationUserGuide, listUserDocuments } from '@/lib/documents'
import { isPostgresPipelineStoreEnabled } from '@/lib/persistence/pipeline'
import { readCrmSummaryFromPostgres } from '@/lib/persistence/crm'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres } from '@/lib/persistence/tasks'
import type { AppUser } from '@/lib/users'

async function readTasks(boardId: string | null) {
  if (!boardId || !isPostgresTaskStoreEnabled()) throw new Error('Task prefetch is unavailable')
  const tasks = await readTasksFromPostgres({ boardId, includeCrmCards: true })
  return tasks.filter((task) => !task.archived)
}

async function readDocs(actor: AppUser): Promise<DashboardDocMeta[]> {
  await ensureApplicationUserGuide(actor)
  const docs = await listUserDocuments(actor)
  return docs.map(({ id, title, category, date, slug }) => ({ id, title, category, date, slug }))
}

async function readPipeline(
  pipelineId: string | null,
  pipelineName: string | null,
): Promise<DashboardPipelineSnapshot> {
  if (!pipelineId || !isPostgresPipelineStoreEnabled()) throw new Error('Pipeline prefetch is unavailable')
  const summary = await readCrmSummaryFromPostgres(pipelineId)
  return {
    summary: {
      opportunities: summary.opportunities,
      organizations: summary.organizations,
      contacts: summary.contacts,
      totalOpenValue: summary.openPipelineValue,
    },
    pipeline: { id: pipelineId, name: pipelineName || 'Pipeline' },
  }
}

export async function buildDashboardBootstrap(actor: AppUser): Promise<DashboardBootstrapPayload> {
  if (!actor.organizationId) throw new Error('Active workspace is not available')
  const workspace = await readDashboardWorkspace(actor, {
    preferDefaults: true,
    ensureDefaults: false,
    compact: true,
  })
  const pipelineName = workspace.pipelines.find(
    (pipeline) => pipeline.id === workspace.selectedPipelineId,
  )?.name || null
  const [tasksResult, docsResult, pipelineResult] = await Promise.allSettled([
    readTasks(workspace.selectedBoardId),
    readDocs(actor),
    readPipeline(workspace.selectedPipelineId, pipelineName),
  ])
  const unavailable: DashboardBootstrapPayload['unavailable'] = []
  if (tasksResult.status === 'rejected') unavailable.push('tasks')
  if (docsResult.status === 'rejected') unavailable.push('docs')
  if (pipelineResult.status === 'rejected') unavailable.push('pipeline')

  return {
    ok: true,
    organizationId: actor.organizationId,
    generatedAt: new Date().toISOString(),
    workspace,
    tasks: tasksResult.status === 'fulfilled' ? tasksResult.value : [],
    docs: docsResult.status === 'fulfilled' ? docsResult.value : [],
    pipelineSnapshot: pipelineResult.status === 'fulfilled' ? pipelineResult.value : null,
    user: { displayName: actor.displayName, email: actor.email },
    availability: {
      tasks: tasksResult.status === 'fulfilled',
      docs: docsResult.status === 'fulfilled',
      pipeline: pipelineResult.status === 'fulfilled',
    },
    unavailable,
  }
}
