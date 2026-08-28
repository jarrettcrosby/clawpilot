'use client'

import { useEffect, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import DescriptionRounded from '@mui/icons-material/DescriptionRounded'
import PriorityHighRounded from '@mui/icons-material/PriorityHighRounded'
import RadioButtonUncheckedRounded from '@mui/icons-material/RadioButtonUncheckedRounded'
import SmartToyRounded from '@mui/icons-material/SmartToyRounded'
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded'
import ViewKanbanRounded from '@mui/icons-material/ViewKanbanRounded'
import WbSunnyRounded from '@mui/icons-material/WbSunnyRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { queueAgentTaskOpen } from '@/lib/agents/navigation'
import { queueProjectTaskOpen } from '@/lib/projects/navigation'
import { deriveLiveState, formatLiveActivityAge } from '@/lib/liveState'
import { deriveNowWorking } from '@/lib/nowWorking'
import type { Task } from '@/lib/types'
import { hourInUserTimeZone } from '@/lib/userDateTime'
import { deriveNextActionGuidance, deriveStateTruth } from '@/lib/workItemModel'
import { formatPipelineCurrency } from '@/lib/crm/pipelineCurrency'
import type {
  DashboardAvailability as Availability,
  DashboardDocMeta as DocMeta,
  DashboardPipelineSnapshot as PipelineSnapshot,
  DashboardUserSummary as UserSummary,
  DashboardWorkspaceSnapshot as WorkspaceSnapshot,
} from '@/lib/dashboardBootstrapTypes'
import { readWorkspaceBootstrap } from '@/lib/workspaceClient'

type Filter = { priority: string[]; status: string[]; labels: string[] }
type Props = {
  onNavigate: (section: string) => void
  onNavigateWithFilter?: (section: string, filter?: Filter) => void
  initialWorkspaceId?: string | null
}

const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
}

const ACTIVE_STATUS_ORDER = ['in-progress', 'todo', 'review', 'backlog']
const BOARD_STATUS_ORDER = ['backlog', 'todo', 'in-progress', 'review', 'done']
const STATUS_COLORS: Record<string, string> = {
  'in-progress': '#A8C7FA',
  todo: '#CFC6EA',
  review: '#FFA726',
  backlog: 'rgba(255,255,255,0.35)',
  done: '#66BB6A',
}
const EMPTY_AVAILABILITY: Availability = {
  tasks: false,
  docs: false,
  pipeline: false,
}

function greeting(timeZone: string) {
  const hour = hourInUserTimeZone(new Date(), timeZone)
  if (hour < 12) return { text: 'Good morning', color: '#FDD663' }
  if (hour < 17) return { text: 'Good afternoon', color: '#FFA726' }
  return { text: 'Good evening', color: '#CFC6EA' }
}

function ownerLabel(agent?: string) {
  if (!agent) return 'Unassigned'
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}

function isCrmCard(task: Task): boolean {
  const candidate = task as Task & { crm?: unknown; entityType?: string }
  return Boolean(candidate.crm)
    || candidate.entityType === 'crm-account'
    || candidate.entityType === 'crm-contact'
}

function taskRequestUrl(boardId?: string | null): string {
  const params = new URLSearchParams({ includeCrmCards: 'true' })
  if (boardId) params.set('boardId', boardId)
  return `/api/tasks?${params.toString()}`
}

function pipelineRequestUrl(boardId?: string | null, pipelineId?: string | null): string {
  const params = new URLSearchParams()
  if (boardId) params.set('boardId', boardId)
  if (pipelineId) params.set('pipelineId', pipelineId)
  const query = params.toString()
  return query ? `/api/pipeline?${query}` : '/api/pipeline'
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceSnapshot>
  return Array.isArray(candidate.boards) && Array.isArray(candidate.pipelines)
}

function isPipelineSnapshot(value: unknown): value is PipelineSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PipelineSnapshot>
  return Boolean(candidate.summary && typeof candidate.summary === 'object')
}

function MetricValue({ available, loading, value }: { available: boolean; loading: boolean; value: number }) {
  if (loading) return <Skeleton variant="text" width={32} height={32} />
  return <Typography variant="h5" fontWeight={700} color="text.primary" lineHeight={1}>{available ? value : '—'}</Typography>
}

export default function DashboardSection({ onNavigate, onNavigateWithFilter, initialWorkspaceId }: Props) {
  const { timeZone } = useUserDateTime()
  const initialBootstrap = initialWorkspaceId ? readWorkspaceBootstrap(initialWorkspaceId) : null
  const [tasks, setTasks] = useState<Task[]>(() => initialBootstrap?.tasks || [])
  const [docs, setDocs] = useState<DocMeta[]>(() => initialBootstrap?.docs || [])
  const [pipelineSnapshot, setPipelineSnapshot] = useState<PipelineSnapshot | null>(
    () => initialBootstrap?.pipelineSnapshot || null,
  )
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(() => initialBootstrap?.workspace || null)
  const [user, setUser] = useState<UserSummary | null>(() => initialBootstrap?.user || null)
  const [availability, setAvailability] = useState<Availability>(
    () => initialBootstrap?.availability || EMPTY_AVAILABILITY,
  )
  const [snapshotTime, setSnapshotTime] = useState(
    () => initialBootstrap ? Date.parse(initialBootstrap.generatedAt) || Date.now() : 0,
  )
  const [loading, setLoading] = useState(!initialBootstrap)
  const [selectionPending, setSelectionPending] = useState<'board' | 'pipeline' | null>(null)
  const [loadWarning, setLoadWarning] = useState(Boolean(initialBootstrap?.unavailable.length))
  const salutation = useMemo(() => greeting(timeZone), [timeZone])
  const selectedBoardId = workspace?.selectedBoardId || ''
  const selectedPipelineId = workspace?.selectedPipelineId || ''

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    async function load() {
      const independentResultsPromise = Promise.allSettled([
        fetchJson('/api/docs', controller.signal),
        fetchJson('/api/users', controller.signal),
      ])
      let nextWorkspace: WorkspaceSnapshot | null = null
      let workspaceFailed = false
      try {
        const value = await fetchJson('/api/workspaces?dashboard=true', controller.signal)
        if (isWorkspaceSnapshot(value)) nextWorkspace = value
        else workspaceFailed = true
      } catch {
        workspaceFailed = true
      }
      if (!active) return
      if (nextWorkspace) setWorkspace(nextWorkspace)

      const boardId = nextWorkspace?.selectedBoardId
      const pipelineId = nextWorkspace?.selectedPipelineId
      const [scopedResults, independentResults] = await Promise.all([
        Promise.allSettled([
          fetchJson(taskRequestUrl(boardId), controller.signal),
          fetchJson(pipelineRequestUrl(boardId, pipelineId), controller.signal),
        ]),
        independentResultsPromise,
      ])
      clearTimeout(timeout)
      if (!active) return

      const [tasksResult, pipelineResult] = scopedResults
      const [docsResult, usersResult] = independentResults
      const results = [tasksResult, docsResult, usersResult, pipelineResult]
      const successfulAvailability = { ...EMPTY_AVAILABILITY }
      if (tasksResult.status === 'fulfilled' && Array.isArray(tasksResult.value)) {
        setTasks(tasksResult.value as Task[])
        successfulAvailability.tasks = true
      }
      if (docsResult.status === 'fulfilled' && Array.isArray(docsResult.value)) {
        setDocs(docsResult.value as DocMeta[])
        successfulAvailability.docs = true
      }
      if (usersResult.status === 'fulfilled' && usersResult.value && typeof usersResult.value === 'object') {
        const currentUser = (usersResult.value as { currentUser?: UserSummary }).currentUser
        if (currentUser) setUser(currentUser)
      }
      if (pipelineResult.status === 'fulfilled' && isPipelineSnapshot(pipelineResult.value)) {
        setPipelineSnapshot(pipelineResult.value)
        successfulAvailability.pipeline = true
      }
      setAvailability((current) => ({
        tasks: successfulAvailability.tasks || current.tasks,
        docs: successfulAvailability.docs || current.docs,
        pipeline: successfulAvailability.pipeline || current.pipeline,
      }))
      setLoadWarning(workspaceFailed || results.some((result) => result.status === 'rejected'))
      setSnapshotTime(Date.now())
      setLoading(false)
    }

    void load()
    return () => {
      active = false
      clearTimeout(timeout)
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (loading) return
    let active = true
    let controller: AbortController | null = null

    async function refreshLiveData() {
      controller?.abort()
      controller = new AbortController()
      const results = await Promise.allSettled([fetchJson(taskRequestUrl(selectedBoardId), controller.signal)])
      if (!active) return
      const [tasksResult] = results
      if (tasksResult.status === 'fulfilled' && Array.isArray(tasksResult.value)) {
        setTasks(tasksResult.value as Task[])
        setAvailability((current) => ({ ...current, tasks: true }))
        setSnapshotTime(Date.now())
      }
      if (results.some((result) => result.status === 'rejected')) setLoadWarning(true)
    }

    const interval = setInterval(() => { void refreshLiveData() }, 30_000)
    return () => {
      active = false
      clearInterval(interval)
      controller?.abort()
    }
  }, [loading, selectedBoardId])

  const boardCards = useMemo(() => tasks.filter((task) => !task.archived), [tasks])
  const operationalTasks = useMemo(() => boardCards.filter((task) => !isCrmCard(task)), [boardCards])
  const activeTasks = useMemo(() => operationalTasks.filter((task) => task.status !== 'done'), [operationalTasks])
  const inProgress = useMemo(() => activeTasks.filter((task) => task.status === 'in-progress'), [activeTasks])
  const highPriority = useMemo(() => activeTasks.filter((task) => task.priority === 'high'), [activeTasks])
  const done = useMemo(() => operationalTasks.filter((task) => task.status === 'done'), [operationalTasks])
  const agentAttention = useMemo(() => operationalTasks.filter((task) => {
    if (!task.assignedAgent) return false
    const executionStatus = String(task.execution?.executionStatus || '').toLowerCase()
    return executionStatus === 'blocked' || executionStatus === 'awaiting_input'
  }), [operationalTasks])
  const referenceTime = snapshotTime || 1
  const nowWorking = useMemo(() => deriveNowWorking(operationalTasks, referenceTime), [operationalTasks, referenceTime])

  const nextActions = useMemo(() => {
    const now = referenceTime
    const priorityRank: Record<string, number> = { high: 30, medium: 20, low: 10 }
    const statusRank: Record<string, number> = { 'in-progress': 40, review: 30, todo: 20, backlog: 10 }
    return activeTasks
      .map(task => {
        const stateTruth = deriveStateTruth({
          workItem: task.workItem,
          checklist: task.checklist,
          executionStatus: task.execution?.executionStatus,
          executionUpdatedAt: task.execution?.lastUpdatedAt,
          updatedAt: task.updatedAt,
          createdAt: task.createdAt,
          nowMs: now,
        })
        const guidance = deriveNextActionGuidance({
          stateTruth,
          workItem: task.workItem,
          checklist: task.checklist,
          executionStatus: task.execution?.executionStatus,
          executionUpdatedAt: task.execution?.lastUpdatedAt,
          updatedAt: task.updatedAt,
          createdAt: task.createdAt,
          nowMs: now,
        })
        const latest = task.execution?.lastResult as { blockedReason?: string } | undefined
        const score = (priorityRank[task.priority] || 0)
          + (statusRank[task.status] || 0)
          + (task.assignedAgent ? 0 : 18)
          + (latest?.blockedReason ? 15 : 0)
        return { task, guidance, blocker: latest?.blockedReason || '', score, live: deriveLiveState(task, now) }
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
  }, [activeTasks, referenceTime])

  const displayName = user?.displayName?.trim() || user?.email?.split('@')[0] || 'there'
  const docsByCategory = useMemo(() => docs.reduce<Record<string, number>>((counts, doc) => {
    counts[doc.category] = (counts[doc.category] || 0) + 1
    return counts
  }, {}), [docs])
  const recentDocs = useMemo(() => [...docs].sort((left, right) => right.date.localeCompare(left.date)).slice(0, 4), [docs])
  const selectedBoard = workspace?.boards.find((board) => board.id === selectedBoardId)
  const selectedPipeline = workspace?.pipelines.find((pipeline) => pipeline.id === selectedPipelineId)
  const taskLoading = loading || selectionPending === 'board'
  const pipelineLoading = loading || selectionPending === 'pipeline'
  const pipelineSummary = pipelineSnapshot?.summary
  const metrics = [
    { label: 'In progress', value: inProgress.length, available: availability.tasks, loading: taskLoading, Icon: TrendingUpRounded, color: '#A8C7FA', action: () => navigateToProjects({ priority: [], status: ['in-progress'], labels: [] }) },
    { label: 'High priority', value: highPriority.length, available: availability.tasks, loading: taskLoading, Icon: PriorityHighRounded, color: '#FFA726', action: () => navigateToProjects({ priority: ['high'], status: [], labels: [] }) },
    { label: 'Open tasks', value: activeTasks.length, available: availability.tasks, loading: taskLoading, Icon: RadioButtonUncheckedRounded, color: '#CFC6EA', action: () => navigateToProjects({ priority: [], status: ACTIVE_STATUS_ORDER, labels: [] }) },
    { label: 'Completed', value: done.length, available: availability.tasks, loading: taskLoading, Icon: CheckCircleRounded, color: '#66BB6A', action: () => navigateToProjects({ priority: [], status: ['done'], labels: [] }) },
    { label: 'Agent attention', value: agentAttention.length, available: availability.tasks, loading: taskLoading, Icon: SmartToyRounded, color: '#4FD1B8', action: () => onNavigate('agents') },
  ]

  function navigateToProjects(filter: Filter) {
    if (onNavigateWithFilter) onNavigateWithFilter('projects', filter)
    else onNavigate('projects')
  }

  function openTask(taskId: string) {
    queueProjectTaskOpen(taskId)
    onNavigate('projects')
    window.dispatchEvent(new CustomEvent('open-task', { detail: { id: taskId } }))
  }

  function openAgentChat(taskId: string, agentId?: string) {
    queueAgentTaskOpen(taskId, agentId || '')
    onNavigate('agents')
  }

  function openDoc(doc: DocMeta) {
    const oldURL = window.location.href
    const url = new URL(window.location.href)
    url.searchParams.set('doc', doc.slug || doc.id)
    url.hash = 'docs'
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: url.toString() }))
  }

  async function updateDashboardSelection(kind: 'board' | 'pipeline', id: string) {
    if (!id || selectionPending) return
    setSelectionPending(kind)
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: kind === 'board' ? 'select-board' : 'select-pipeline',
          ...(kind === 'board' ? { boardId: id } : { pipelineId: id }),
          setDefault: true,
        }),
      })
      if (!response.ok) throw new Error(`Workspace selection returned ${response.status}`)
      const value = await response.json()
      if (!isWorkspaceSnapshot(value)) throw new Error('Workspace selection returned an invalid response')
      setWorkspace(value)

      if (kind === 'board') {
        setTasks([])
        setAvailability((current) => ({ ...current, tasks: false }))
        const taskValue = await fetchJson(taskRequestUrl(value.selectedBoardId))
        if (!Array.isArray(taskValue)) throw new Error('Project board returned an invalid response')
        setTasks(taskValue as Task[])
        setAvailability((current) => ({ ...current, tasks: true }))
        setSnapshotTime(Date.now())
      } else {
        setPipelineSnapshot(null)
        setAvailability((current) => ({ ...current, pipeline: false }))
        const pipelineValue = await fetchJson(pipelineRequestUrl(value.selectedBoardId, value.selectedPipelineId))
        if (!isPipelineSnapshot(pipelineValue)) throw new Error('Pipeline returned an invalid response')
        setPipelineSnapshot(pipelineValue)
        setAvailability((current) => ({ ...current, pipeline: true }))
      }
    } catch {
      setLoadWarning(true)
    } finally {
      setSelectionPending(null)
    }
  }

  return (
    <Box sx={{ width: '100%', maxWidth: 1120, mx: 'auto', px: { xs: 2, sm: 3 }, py: { xs: 3, sm: 4 }, overflowX: 'hidden' }}>
      <Stack direction="row" alignItems="center" spacing={1.25} mb={0.5}>
        <WbSunnyRounded sx={{ color: salutation.color, fontSize: 26 }} />
        <Typography variant="h4" fontWeight={700} color="text.primary" sx={{ fontSize: { xs: '1.5rem', sm: '2rem' }, overflowWrap: 'anywhere' }}>
          {salutation.text}, {displayName}
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" mb={2.5} ml={{ sm: 5 }}>
        Current work, agent activity, and workspace knowledge.
      </Typography>

      {loading && !workspace ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5, mb: 3 }}>
          <Skeleton variant="rounded" height={52} />
          <Skeleton variant="rounded" height={52} />
        </Box>
      ) : workspace ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5, mb: 3 }}>
          <TextField
            select
            size="small"
            label="Dashboard board"
            value={selectedBoardId}
            disabled={Boolean(selectionPending)}
            onChange={(event) => { void updateDashboardSelection('board', event.target.value) }}
          >
            {workspace.boards.map((board) => <MenuItem key={board.id} value={board.id}>{board.name}</MenuItem>)}
          </TextField>
          <TextField
            select
            size="small"
            label="Dashboard pipeline"
            value={selectedPipelineId}
            disabled={Boolean(selectionPending)}
            onChange={(event) => { void updateDashboardSelection('pipeline', event.target.value) }}
          >
            {workspace.pipelines.map((pipeline) => <MenuItem key={pipeline.id} value={pipeline.id}>{pipeline.name}</MenuItem>)}
          </TextField>
        </Box>
      ) : null}

      {loadWarning && (
        <Box sx={{ borderLeft: '3px solid #FFA726', px: 1.5, py: 1, mb: 2.5, bgcolor: 'rgba(255,167,38,0.06)' }}>
          <Typography variant="body2" color="text.secondary">Some workspace data is temporarily unavailable. Available sections remain usable.</Typography>
        </Box>
      )}

      <Box
        aria-label="Workspace pulse"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(5, minmax(0, 1fr))' },
          borderTop: '1px solid rgba(255,255,255,0.08)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          mb: 3.5,
        }}
      >
        {metrics.map(({ label, value, available, loading: metricLoading, Icon, color, action }) => (
          <ButtonBase key={label} onClick={action} sx={{ minWidth: 0, minHeight: 88, px: 1.5, py: 1.25, justifyContent: 'flex-start', textAlign: 'left', borderRadius: 0, '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' } }}>
            <Box minWidth={0}>
              <Icon sx={{ color, fontSize: 19, mb: 0.75 }} />
              <MetricValue available={available} loading={metricLoading} value={value} />
              <Typography variant="caption" color="text.secondary" display="block" mt={0.6}>{label}</Typography>
            </Box>
          </ButtonBase>
        ))}
      </Box>

      <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: { xs: 1.75, sm: 2.25 }, mb: 3 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1.5} mb={1}>
          <Typography variant="subtitle2" fontWeight={700} color="text.primary">Current Agent Activity</Typography>
          {taskLoading ? <Skeleton variant="rounded" width={92} height={24} /> : (
            <Chip
              size="small"
              label={availability.tasks ? nowWorking?.label || 'No recent run' : 'Unavailable'}
              sx={{ height: 24, borderRadius: 1, bgcolor: nowWorking?.state === 'now_working' ? 'rgba(79,209,184,0.14)' : 'rgba(255,255,255,0.07)', color: nowWorking?.state === 'now_working' ? '#4FD1B8' : 'text.secondary' }}
            />
          )}
        </Stack>
        {taskLoading ? (
          <Stack spacing={0.75}><Skeleton width="55%" /><Skeleton width="35%" /></Stack>
        ) : !availability.tasks ? (
          <Typography variant="body2" color="text.secondary">Agent activity is temporarily unavailable.</Typography>
        ) : nowWorking && nowWorking.state !== 'no_recent_run' ? (
          <Stack spacing={0.65}>
            <Typography variant="body2" color="text.primary" fontWeight={700}>{nowWorking.taskTitle}</Typography>
            <Typography variant="caption" color="text.secondary">
              {ownerLabel(nowWorking.agentId)} · {formatLiveActivityAge(nowWorking.latestTimestamp || '', referenceTime)}
            </Typography>
            <Stack direction="row" spacing={1} mt={0.5}>
              <Button size="small" variant="outlined" onClick={() => openAgentChat(nowWorking.taskId, nowWorking.agentId)}>Open thread</Button>
              <Button size="small" variant="text" onClick={() => openTask(nowWorking.taskId)}>Open task</Button>
            </Stack>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">No agent is currently reporting task activity.</Typography>
        )}
      </Box>

      <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, px: { xs: 1.75, sm: 2.25 }, py: 1, mb: 3 }}>
        <Typography variant="subtitle2" fontWeight={700} color="text.primary" py={1.25}>Next Actions</Typography>
        {taskLoading ? (
          <Stack spacing={1.25} pb={1.5}><Skeleton height={28} /><Skeleton height={28} /><Skeleton height={28} /></Stack>
        ) : !availability.tasks ? (
          <Typography variant="body2" color="text.secondary" pb={1.5}>Project data is temporarily unavailable.</Typography>
        ) : nextActions.length === 0 ? (
          <Typography variant="body2" color="text.secondary" pb={1.5}>No active work needs attention.</Typography>
        ) : nextActions.map(({ task, guidance, blocker, live }, index) => (
          <Box key={task.id}>
            {index > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)' }} />}
            <Box sx={{ py: 1.5 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" gap={1}>
                <Box minWidth={0}>
                  <Typography variant="body2" color="text.primary" fontWeight={700} sx={{ overflowWrap: 'anywhere' }}>{task.title}</Typography>
                  <Typography variant="caption" color="text.secondary" display="block" mt={0.4} sx={{ overflowWrap: 'anywhere' }}>{guidance}</Typography>
                  <Typography variant="caption" color="text.disabled" display="block" mt={0.35}>
                    {ownerLabel(task.assignedAgent)} · {formatLiveActivityAge(live.lastActivityAt, referenceTime)}
                  </Typography>
                  {blocker && <Typography variant="caption" color="#FFA726" display="block" mt={0.35}>Waiting on: {blocker}</Typography>}
                </Box>
                <Stack direction="row" spacing={0.75} flexShrink={0}>
                  <Button size="small" variant="text" onClick={() => openTask(task.id)}>Open task</Button>
                  {task.assignedAgent && <Button size="small" variant="outlined" onClick={() => openAgentChat(task.id, task.assignedAgent)}>Open thread</Button>}
                </Stack>
              </Stack>
            </Box>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' }, gap: 2.5 }}>
        <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5} gap={1}>
            <Stack direction="row" alignItems="center" spacing={1} minWidth={0}>
              <ViewKanbanRounded sx={{ fontSize: 19, color: '#A8C7FA' }} />
              <Box minWidth={0}>
                <Typography variant="subtitle2" fontWeight={700} color="text.primary">Project Board</Typography>
                <Typography variant="caption" color="text.secondary" noWrap display="block">{selectedBoard?.name || 'Default board'}</Typography>
              </Box>
            </Stack>
            <Button size="small" variant="text" onClick={() => onNavigate('projects')} sx={{ flexShrink: 0 }}>View board</Button>
          </Stack>
          {BOARD_STATUS_ORDER.map(status => (
            <ButtonBase key={status} onClick={() => navigateToProjects({ priority: [], status: [status], labels: [] })} sx={{ width: '100%', minHeight: 40, px: 0.5, borderRadius: 1, justifyContent: 'space-between', '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' } }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATUS_COLORS[status] }} />
                <Typography variant="body2" color="text.secondary">{STATUS_LABELS[status]}</Typography>
              </Stack>
              {taskLoading ? <Skeleton width={18} /> : (
                <Typography variant="body2" color="text.primary" fontWeight={700}>
                  {availability.tasks ? boardCards.filter(task => task.status === status).length : '—'}
                </Typography>
              )}
            </ButtonBase>
          ))}
          {availability.tasks && inProgress.slice(0, 4).length > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', my: 1.5 }} />}
          {availability.tasks && inProgress.slice(0, 4).map(task => (
            <ButtonBase key={task.id} onClick={() => openTask(task.id)} sx={{ width: '100%', minHeight: 42, px: 0.5, borderRadius: 1, justifyContent: 'flex-start', textAlign: 'left', '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' } }}>
              <Box minWidth={0}>
                <Typography variant="body2" color="text.primary" noWrap>{task.title}</Typography>
                <Typography variant="caption" color="text.disabled">{ownerLabel(task.assignedAgent)}</Typography>
              </Box>
            </ButtonBase>
          ))}
        </Box>

        <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5} gap={1}>
            <Stack direction="row" alignItems="center" spacing={1} minWidth={0}>
              <AccountBalanceRounded sx={{ fontSize: 19, color: '#4FD1B8' }} />
              <Box minWidth={0}>
                <Typography variant="subtitle2" fontWeight={700} color="text.primary">Pipeline</Typography>
                <Typography variant="caption" color="text.secondary" noWrap display="block">{selectedPipeline?.name || pipelineSnapshot?.pipeline?.name || 'Default pipeline'}</Typography>
              </Box>
            </Stack>
            <Button size="small" variant="text" onClick={() => onNavigate('pipeline')} sx={{ flexShrink: 0 }}>View pipeline</Button>
          </Stack>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2, pt: 0.5 }}>
            {[
              ['Total opportunities', pipelineSummary?.opportunities ?? 0],
              ['Active opportunities', pipelineSummary?.activeOpportunities ?? 0],
              ['Active pipeline value', formatPipelineCurrency(pipelineSummary?.activePipelineValue ?? pipelineSummary?.totalOpenValue ?? 0)],
              ['Weighted pipeline value', formatPipelineCurrency(pipelineSummary?.weightedPipelineValue ?? 0)],
              ['Organizations', pipelineSummary?.organizations ?? 0],
              ['Contacts', pipelineSummary?.contacts ?? 0],
            ].map(([label, value]) => (
              <Box key={label} minWidth={0}>
                {pipelineLoading ? <Skeleton variant="text" width="70%" height={30} /> : (
                  <Typography variant="h6" fontWeight={700} color="text.primary" noWrap>{availability.pipeline ? value : '—'}</Typography>
                )}
                <Typography variant="caption" color="text.secondary">{label}</Typography>
              </Box>
            ))}
          </Box>
        </Box>

        <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <DescriptionRounded sx={{ fontSize: 19, color: '#CFC6EA' }} />
              <Typography variant="subtitle2" fontWeight={700} color="text.primary">Documents</Typography>
            </Stack>
            <Button size="small" variant="text" onClick={() => onNavigate('docs')}>View docs</Button>
          </Stack>
          {loading ? (
            <Stack spacing={1}><Skeleton height={28} /><Skeleton height={42} /><Skeleton height={42} /></Stack>
          ) : !availability.docs ? (
            <Typography variant="body2" color="text.secondary" py={1}>Documents are temporarily unavailable.</Typography>
          ) : (
            <>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap mb={1.5}>
                {Object.entries(docsByCategory).slice(0, 6).map(([category, count]) => (
                  <Chip key={category} size="small" label={`${category} ${count}`} sx={{ height: 24, borderRadius: 1, bgcolor: 'rgba(207,198,234,0.09)', color: '#CFC6EA' }} />
                ))}
              </Stack>
              <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', mb: 0.75 }} />
              {recentDocs.length === 0 ? (
                <Typography variant="body2" color="text.secondary" py={1}>No documents yet.</Typography>
              ) : recentDocs.map(doc => (
                <ButtonBase key={doc.id} onClick={() => openDoc(doc)} sx={{ width: '100%', minHeight: 48, px: 0.5, borderRadius: 1, justifyContent: 'flex-start', textAlign: 'left', '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' } }}>
                  <Box minWidth={0}>
                    <Typography variant="body2" color="text.primary" noWrap>{doc.title}</Typography>
                    <Typography variant="caption" color="text.disabled">{doc.category}{doc.date ? ` · ${doc.date}` : ''}</Typography>
                  </Box>
                </ButtonBase>
              ))}
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}
