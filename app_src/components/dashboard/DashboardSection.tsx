'use client'

import { useEffect, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
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

type DocMeta = {
  id: string
  title: string
  category: string
  date: string
  slug: string
}

type ExecutionSummary = { count: number }
type UserSummary = { displayName?: string | null; email?: string }
type Filter = { priority: string[]; status: string[]; labels: string[] }
type Props = {
  onNavigate: (section: string) => void
  onNavigateWithFilter?: (section: string, filter?: Filter) => void
}

const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
}

const STATUS_ORDER = ['in-progress', 'todo', 'review', 'backlog']
const STATUS_COLORS: Record<string, string> = {
  'in-progress': '#A8C7FA',
  todo: '#CFC6EA',
  review: '#FFA726',
  backlog: 'rgba(255,255,255,0.35)',
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

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

export default function DashboardSection({ onNavigate, onNavigateWithFilter }: Props) {
  const { timeZone } = useUserDateTime()
  const [tasks, setTasks] = useState<Task[]>([])
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [executionResults, setExecutionResults] = useState<ExecutionSummary | null>(null)
  const [user, setUser] = useState<UserSummary | null>(null)
  const [snapshotTime, setSnapshotTime] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadWarning, setLoadWarning] = useState(false)
  const salutation = useMemo(() => greeting(timeZone), [timeZone])

  useEffect(() => {
    let active = true

    async function load() {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      const results = await Promise.allSettled([
        fetchJson('/api/tasks', controller.signal),
        fetchJson('/api/docs', controller.signal),
        fetchJson('/api/execution-results/summary', controller.signal),
        fetchJson('/api/users', controller.signal),
      ])
      clearTimeout(timeout)
      if (!active) return

      const [tasksResult, docsResult, executionResult, usersResult] = results
      if (tasksResult.status === 'fulfilled') setTasks(Array.isArray(tasksResult.value) ? tasksResult.value as Task[] : [])
      if (docsResult.status === 'fulfilled') setDocs(Array.isArray(docsResult.value) ? docsResult.value as DocMeta[] : [])
      if (executionResult.status === 'fulfilled' && executionResult.value && typeof executionResult.value === 'object') {
        setExecutionResults(executionResult.value as ExecutionSummary)
      }
      if (usersResult.status === 'fulfilled' && usersResult.value && typeof usersResult.value === 'object') {
        const currentUser = (usersResult.value as { currentUser?: UserSummary }).currentUser
        if (currentUser) setUser(currentUser)
      }
      setLoadWarning(results.slice(0, 2).some(result => result.status === 'rejected'))
      setSnapshotTime(Date.now())
      setLoading(false)
    }

    void load()
    const interval = setInterval(() => { void load() }, 30_000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])

  const activeTasks = useMemo(() => tasks.filter(task => task.status !== 'done' && !task.archived), [tasks])
  const inProgress = useMemo(() => activeTasks.filter(task => task.status === 'in-progress'), [activeTasks])
  const highPriority = useMemo(() => activeTasks.filter(task => task.priority === 'high'), [activeTasks])
  const done = useMemo(() => tasks.filter(task => task.status === 'done' && !task.archived), [tasks])
  const referenceTime = snapshotTime || 1
  const nowWorking = useMemo(() => deriveNowWorking(tasks, referenceTime), [referenceTime, tasks])

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

  if (loading) {
    return <Box display="flex" justifyContent="center" pt={8}><CircularProgress size={28} /></Box>
  }

  const metrics = [
    { label: 'In progress', value: inProgress.length, Icon: TrendingUpRounded, color: '#A8C7FA', action: () => navigateToProjects({ priority: [], status: ['in-progress'], labels: [] }) },
    { label: 'High priority', value: highPriority.length, Icon: PriorityHighRounded, color: '#FFA726', action: () => navigateToProjects({ priority: ['high'], status: [], labels: [] }) },
    { label: 'Open tasks', value: activeTasks.length, Icon: RadioButtonUncheckedRounded, color: '#CFC6EA', action: () => navigateToProjects({ priority: [], status: STATUS_ORDER, labels: [] }) },
    { label: 'Completed', value: done.length, Icon: CheckCircleRounded, color: '#66BB6A', action: () => navigateToProjects({ priority: [], status: ['done'], labels: [] }) },
    { label: 'Agent results', value: executionResults?.count || 0, Icon: SmartToyRounded, color: '#4FD1B8', action: () => onNavigate('agents') },
  ]

  return (
    <Box sx={{ width: '100%', maxWidth: 1120, mx: 'auto', px: { xs: 2, sm: 3 }, py: { xs: 3, sm: 4 }, overflowX: 'hidden' }}>
      <Stack direction="row" alignItems="center" spacing={1.25} mb={0.5}>
        <WbSunnyRounded sx={{ color: salutation.color, fontSize: 26 }} />
        <Typography variant="h4" fontWeight={700} color="text.primary" sx={{ fontSize: { xs: '1.5rem', sm: '2rem' }, overflowWrap: 'anywhere' }}>
          {salutation.text}, {displayName}
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" mb={3.5} ml={{ sm: 5 }}>
        Current work, agent activity, and workspace knowledge.
      </Typography>

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
        {metrics.map(({ label, value, Icon, color, action }) => (
          <ButtonBase key={label} onClick={action} sx={{ minWidth: 0, minHeight: 88, px: 1.5, py: 1.25, justifyContent: 'flex-start', textAlign: 'left', borderRadius: 0, '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' } }}>
            <Box minWidth={0}>
              <Icon sx={{ color, fontSize: 19, mb: 0.75 }} />
              <Typography variant="h5" fontWeight={700} color="text.primary" lineHeight={1}>{value}</Typography>
              <Typography variant="caption" color="text.secondary" display="block" mt={0.6}>{label}</Typography>
            </Box>
          </ButtonBase>
        ))}
      </Box>

      <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: { xs: 1.75, sm: 2.25 }, mb: 3 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1.5} mb={1}>
          <Typography variant="subtitle2" fontWeight={700} color="text.primary">Current Agent Activity</Typography>
          <Chip
            size="small"
            label={nowWorking?.label || 'No recent run'}
            sx={{ height: 24, borderRadius: 1, bgcolor: nowWorking?.state === 'now_working' ? 'rgba(79,209,184,0.14)' : 'rgba(255,255,255,0.07)', color: nowWorking?.state === 'now_working' ? '#4FD1B8' : 'text.secondary' }}
          />
        </Stack>
        {nowWorking && nowWorking.state !== 'no_recent_run' ? (
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
        {nextActions.length === 0 ? (
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

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: 2.5 }}>
        <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <ViewKanbanRounded sx={{ fontSize: 19, color: '#A8C7FA' }} />
              <Typography variant="subtitle2" fontWeight={700} color="text.primary">Project Board</Typography>
            </Stack>
            <Button size="small" variant="text" onClick={() => onNavigate('projects')}>View board</Button>
          </Stack>
          {STATUS_ORDER.map(status => (
            <ButtonBase key={status} onClick={() => navigateToProjects({ priority: [], status: [status], labels: [] })} sx={{ width: '100%', minHeight: 40, px: 0.5, borderRadius: 1, justifyContent: 'space-between', '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' } }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATUS_COLORS[status] }} />
                <Typography variant="body2" color="text.secondary">{STATUS_LABELS[status]}</Typography>
              </Stack>
              <Typography variant="body2" color="text.primary" fontWeight={700}>{activeTasks.filter(task => task.status === status).length}</Typography>
            </ButtonBase>
          ))}
          {inProgress.slice(0, 4).length > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', my: 1.5 }} />}
          {inProgress.slice(0, 4).map(task => (
            <ButtonBase key={task.id} onClick={() => openTask(task.id)} sx={{ width: '100%', minHeight: 42, px: 0.5, borderRadius: 1, justifyContent: 'flex-start', textAlign: 'left', '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' } }}>
              <Box minWidth={0}>
                <Typography variant="body2" color="text.primary" noWrap>{task.title}</Typography>
                <Typography variant="caption" color="text.disabled">{ownerLabel(task.assignedAgent)}</Typography>
              </Box>
            </ButtonBase>
          ))}
        </Box>

        <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <DescriptionRounded sx={{ fontSize: 19, color: '#CFC6EA' }} />
              <Typography variant="subtitle2" fontWeight={700} color="text.primary">Documents</Typography>
            </Stack>
            <Button size="small" variant="text" onClick={() => onNavigate('docs')}>View docs</Button>
          </Stack>
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
        </Box>
      </Box>
    </Box>
  )
}
