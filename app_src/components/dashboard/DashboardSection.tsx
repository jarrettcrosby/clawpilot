'use client'

import { useEffect, useMemo, useState } from 'react'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Stack from '@mui/material/Stack'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import ViewKanbanRounded from '@mui/icons-material/ViewKanbanRounded'
import DescriptionRounded from '@mui/icons-material/DescriptionRounded'
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import RadioButtonUncheckedRounded from '@mui/icons-material/RadioButtonUncheckedRounded'
import FlagRounded from '@mui/icons-material/FlagRounded'
import WbSunnyRounded from '@mui/icons-material/WbSunnyRounded'
import type { Task } from '@/lib/types'
import { queueAgentTaskOpen } from '@/lib/agents/navigation'
import { assignmentKickoffText, triggerAgentTurn } from '@/lib/agents/client'
import { PRIORITY_COLORS } from '@/lib/types'
import { deriveTaskRealityState } from '@/lib/taskRealityState'
import { deriveNextActionGuidance, deriveStateTruth } from '@/lib/workItemModel'
import { deriveLiveState, formatLiveActivityAge } from '@/lib/liveState'
import { deriveNowWorking } from '@/lib/nowWorking'

type DocMeta = { id: string; title: string; category: string; date: string }
type ExecutionSummary = { count: number; last: { status?: string; name?: string } | null }
type NightlyStatusSummary = {
  run: { status?: string } | null
  briefing: { name?: string } | null
}

type TaskCreationAuditSummary = {
  created24h: number
  lastCreated: {
    timestamp: string | null
    source: string | null
    actor: string | null
    taskId: string | null
    title: string | null
    anomaly: boolean
    recentCreatesInLastMinute?: number
  } | null
}

const STATUS_ORDER = ['in-progress', 'todo', 'review', 'backlog', 'done']
const STATUS_LABELS: Record<string, string> = {
  'in-progress': 'In Progress',
  'todo': 'To Do',
  'review': 'Review',
  'backlog': 'Backlog',
  'done': 'Done',
}
const STATUS_COLORS: Record<string, string> = {
  'in-progress': '#A8C7FA',
  'todo': '#CFC6EA',
  'review': '#FFA726',
  'backlog': 'rgba(255,255,255,0.3)',
  'done': '#66BB6A',
}

const BOARD_RANK: Record<string, number> = {
  'in-progress': 40,
  'todo': 30,
  'review': 20,
  'backlog': 10,
  'done': 0,
}
const PRIORITY_RANK: Record<string, number> = { high: 35, medium: 20, low: 10 }
const EXECUTION_RANK: Record<string, number> = {
  blocked: 35,
  awaiting_input: 30,
  queued: 22,
  running: 18,
  completed: 6,
}

function dueScore(dueDate?: string) {
  if (!dueDate) return 0
  const today = new Date()
  const due = new Date(`${dueDate}T23:59:59`)
  const days = Math.floor((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  if (days <= 0) return 35
  if (days <= 2) return 24
  if (days <= 7) return 15
  return 6
}

function assignedLabel(agent?: string) {
  if (!agent) return 'Unassigned'
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}

function formatAgeSince(timestamp: string | null) {
  if (!timestamp) return null
  const ms = Date.now() - new Date(timestamp).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / (60 * 1000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const QUICK_ASSIGN_ORDER = ['projects', 'pipeline', 'docs', 'calendar', 'clawpilot']

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return { text: 'Good morning', color: '#FDD663' }
  if (h < 17) return { text: 'Good afternoon', color: '#FFA726' }
  return { text: 'Good evening', color: '#CFC6EA' }
}

type Props = { onNavigate: (s: string) => void; onNavigateWithFilter?: (s: string, filter?: { priority: string[]; status: string[]; labels: string[] }) => void }

export default function DashboardSection({ onNavigate, onNavigateWithFilter }: Props) {
  const theme = useTheme()
  const isXs = useMediaQuery(theme.breakpoints.down('sm'))
  const isLandscape = useMediaQuery('(orientation: landscape)')
  const compactMobile = isXs && isLandscape

  const [tasks, setTasks] = useState<Task[]>([])
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [greeting] = useState<{ text: string; color: string }>(() => getGreeting())
  const [snapshotTime, setSnapshotTime] = useState(0)
  const [promotionReport, setPromotionReport] = useState<{
    status: string
    timestamp: string | null
    timestampIso: string | null
    runtime: { lane?: string; port?: string; commit?: string; repoPath?: string } | null
    blockers: string[]
    reason?: string
  } | null>(null)
  const [runtimeLane, setRuntimeLane] = useState<string | null>(null)
  const [executionRuns, setExecutionRuns] = useState<ExecutionSummary | null>(null)
  const [executionResults, setExecutionResults] = useState<ExecutionSummary | null>(null)
  const [nightlyStatus, setNightlyStatus] = useState<NightlyStatusSummary | null>(null)
  const [taskCreationAudit, setTaskCreationAudit] = useState<TaskCreationAuditSummary | null>(null)

  useEffect(() => {
    let mounted = true

    async function loadSnapshot() {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        const [t, d, p, runtime, runs, results, nightly, taskCreateAudit] = await Promise.all([
          fetch('/api/tasks', { signal: controller.signal }).then(r => r.json()),
          fetch('/api/docs', { signal: controller.signal }).then(r => r.json()),
          fetch('/api/promotion-report', { signal: controller.signal }).then(r => r.json()),
          fetch('/api/runtime', { signal: controller.signal }).then(r => r.json()),
          fetch('/api/execution-runs/summary', { signal: controller.signal }).then(r => r.json()),
          fetch('/api/execution-results/summary', { signal: controller.signal }).then(r => r.json()),
          fetch('/api/nightly-status', { signal: controller.signal }).then(r => r.json()),
          fetch('/api/task-creation-audit/summary', { signal: controller.signal }).then(r => r.json()),
        ])
        if (!mounted) return
        setTasks(Array.isArray(t) ? t : [])
        setDocs(Array.isArray(d) ? d : [])
        setSnapshotTime(Date.now())
        setPromotionReport(p && typeof p === 'object' ? p : null)
        setRuntimeLane(runtime?.lane || null)
        setExecutionRuns(runs && typeof runs === 'object' ? runs : null)
        setExecutionResults(results && typeof results === 'object' ? results : null)
        setNightlyStatus(nightly && typeof nightly === 'object' ? nightly : null)
        setTaskCreationAudit(taskCreateAudit && typeof taskCreateAudit === 'object' ? taskCreateAudit : null)
      } catch {
        if (!mounted) return
        setTasks([])
        setDocs([])
        setSnapshotTime(Date.now())
        setPromotionReport(null)
        setRuntimeLane(null)
        setExecutionRuns(null)
        setExecutionResults(null)
        setNightlyStatus(null)
        setTaskCreationAudit(null)
      } finally {
        clearTimeout(timeout)
        if (mounted) setLoading(false)
      }
    }

    void loadSnapshot()
    const interval = setInterval(() => { void loadSnapshot() }, 20000)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  const activeTasks = tasks.filter(t => t.status !== 'done')
  const inProgress = tasks.filter(t => t.status === 'in-progress')
  const highPriority = activeTasks.filter(t => t.priority === 'high')
  const doneTasks = tasks.filter(t => t.status === 'done')
  const staleInProgress = inProgress.filter(t => {
    const ts = t.updatedAt || t.createdAt
    if (!ts) return false
    const ageMs = snapshotTime - new Date(ts).getTime()
    return ageMs > 3 * 24 * 60 * 60 * 1000
  })
  const oldestStaleInProgress = useMemo(() => {
    if (!staleInProgress.length) return null
    return [...staleInProgress].sort((a, b) => {
      const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime()
      const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime()
      return aTs - bTs
    })[0]
  }, [staleInProgress])

  const nowWorking = useMemo(() => deriveNowWorking(tasks, snapshotTime || Date.now()), [tasks, snapshotTime])

  const topActions = useMemo(() => {
    const nowMs = Date.now()
    const actionable = tasks.filter((task) => !task.archived)

    const ranked = actionable.map((task) => {
      const executionStatus = String(task.execution?.executionStatus || '').toLowerCase()
      const note = String(task.execution?.latestExecutionNote || '')
      const lastResult = (task.execution?.lastResult || {}) as { nextAction?: string; blockedReason?: string }
      const explicitBlocker = (lastResult.blockedReason || '').trim() || ((note.match(/^Blocker\s*:\s*(.+)$/im) || [])[1] || '').trim() || ((note.match(/^Blocked reason\s*:\s*(.+)$/im) || [])[1] || '').trim()
      const unassigned = !task.assignedAgent
      const realityState = deriveTaskRealityState(task, nowMs)

      const baseScore =
        (PRIORITY_RANK[task.priority] || 0) +
        dueScore(task.dueDate) +
        (EXECUTION_RANK[executionStatus] || 0) +
        (BOARD_RANK[task.status] || 0) +
        (unassigned ? 28 : 0)

      const score = baseScore + (realityState === 'DONE_UNCONFIRMED' ? -32 : 0)

      let whyNow = 'This can move immediately and unlock visible progress today.'
      if (realityState === 'DONE_UNCONFIRMED') whyNow = 'Execution looks complete, but closure still needs confirmation.'
      else if (unassigned) whyNow = 'No owner is set, so this work is stalled right now.'
      else if (explicitBlocker || realityState === 'BLOCKED') whyNow = 'A blocker is actively stopping delivery on this task.'
      else if (task.priority === 'high') whyNow = 'High-priority work: moving this now protects momentum.'
      else if (task.dueDate) whyNow = `Due ${task.dueDate}, so this needs action now to avoid slip.`

      const fallbackAction = realityState === 'DONE_UNCONFIRMED'
        ? 'Confirm completion now: close the task if accepted, or post the missing follow-up needed to finish.'
        : unassigned
          ? 'Assign an owner now, then send a task-linked kickoff with exact scope and deadline.'
          : task.status === 'backlog' || task.status === 'todo'
            ? `Move this to in-progress and send ${assignedLabel(task.assignedAgent)} the exact deliverable and deadline.`
            : (explicitBlocker || realityState === 'BLOCKED')
              ? `Provide this missing input now: ${explicitBlocker || 'clarify the blocker details'}.`
              : `Send ${assignedLabel(task.assignedAgent)} one clear instruction with scope, deadline, and expected output.`

      const nextActionRaw = String(lastResult.nextAction || '').trim()
      const nextAction = nextActionRaw || fallbackAction

      const stateTruth = deriveStateTruth({
        workItem: task.workItem,
        checklist: task.checklist,
        executionStatus: task.execution?.executionStatus,
        executionUpdatedAt: task.execution?.lastUpdatedAt,
        updatedAt: task.updatedAt,
        createdAt: task.createdAt,
        nowMs,
      })
      const nextGuidance = deriveNextActionGuidance({
        stateTruth,
        workItem: task.workItem,
        checklist: task.checklist,
        executionStatus: task.execution?.executionStatus,
        executionUpdatedAt: task.execution?.lastUpdatedAt,
        updatedAt: task.updatedAt,
        createdAt: task.createdAt,
        nowMs,
      })

      const liveState = deriveLiveState(task, nowMs)
      return {
        task,
        score,
        whyNow,
        blocker: explicitBlocker || (unassigned ? 'No assigned agent.' : ''),
        nextAction,
        nextGuidance,
        assigned: liveState.owner,
        liveState,
        realityState,
        stateTruth,
      }
    })

    return ranked
      .filter((item) => item.realityState !== 'DONE_CONFIRMED')
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
  }, [tasks])

  const statusCounts = STATUS_ORDER.reduce((acc, s) => {
    acc[s] = tasks.filter(t => t.status === s).length
    return acc
  }, {} as Record<string, number>)

  const docsByCategory = docs.reduce((acc, d) => {
    acc[d.category] = (acc[d.category] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  const recentDocs = [...docs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3)

  const promoStatus = promotionReport?.status || 'unknown'
  const promoReady = promoStatus === 'ready'
  const promoTimestamp = promotionReport?.timestampIso || promotionReport?.timestamp || 'unknown'
  const promoRuntime = promotionReport?.runtime
  const promoBlockers = promotionReport?.blockers || []
  const promoLane = promoRuntime?.lane
  const promoDisabled = promoStatus === 'disabled' || promotionReport?.reason === 'not-dev'
  const showPromotion = (runtimeLane === 'dev' || promoLane === 'dev') && !promoDisabled
  const verificationLabel = promoReady ? 'Verified' : 'Needs verify'
  const verificationColor = promoReady ? '#66BB6A' : '#FFA726'
  const verificationTimestamp = promotionReport?.timestampIso || promotionReport?.timestamp || null
  const verificationAge = formatAgeSince(verificationTimestamp)

  function openTask(taskId: string) {
    onNavigate('projects')
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('open-task', { detail: { id: taskId } }))
    }, 120)
  }

  function openAgentChat(taskId: string, agentId?: string) {
    queueAgentTaskOpen(taskId, agentId || '')
    onNavigate('agents')
  }

  function openVerificationEvidence() {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('doc', 'promotion-reports')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    } catch {
      // Fail open: still navigate to Docs even if URL mutation fails.
    }
    onNavigate('docs')
  }

  async function quickAssign(taskId: string, agentId: string) {
    const nowIso = new Date().toISOString()
    const r = await fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: taskId,
        assignedAgent: agentId,
        _execution: {
          assignedAgent: agentId,
          executionStatus: 'queued',
          lastUpdatedAt: nowIso,
          latestExecutionNote: `Assigned from Do This Now panel to ${agentId}.`,
        },
        _actor: 'ClawPilot',
      }),
    })
    if (!r.ok) return
    const updated = await r.json()
    if (!updated?.id) return
    setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)))
    await triggerAgentTurn({ taskId, agentId, text: assignmentKickoffText() }).catch(() => {})
  }

  if (loading) return (
    <Box display="flex" justifyContent="center" pt={8}><CircularProgress size={28} /></Box>
  )

  return (
    <Box p={{ xs: compactMobile ? 1.5 : 2, sm: 3 }} pt={{ xs: compactMobile ? 2 : 3, sm: 4 }} maxWidth={800} sx={{ width: '100%', overflowX: 'hidden' }}>
      {/* Greeting */}
      <Stack direction="row" alignItems="center" spacing={1.2} mb={0.5}>
        <WbSunnyRounded sx={{ color: greeting.color, fontSize: compactMobile ? 22 : 28 }} />
        <Typography variant="h4" fontWeight={700} color="text.primary" sx={{ fontSize: { xs: compactMobile ? '1.25rem' : '1.5rem', sm: '2.125rem' } }}>
          {greeting.text}, Jarrett
        </Typography>
      </Stack>
      <Typography variant="body1" color="text.secondary" ml={{ xs: compactMobile ? 0 : 4, sm: 5 }} mb={{ xs: compactMobile ? 2.5 : 4, sm: 4 }} sx={{ fontSize: { xs: '0.9rem', sm: '1rem' } }}>
        Here&apos;s your command center.
      </Typography>

      {showPromotion && (
        <Box sx={{ backgroundColor: '#16161E', border: `1px solid ${promoReady ? 'rgba(102,187,106,0.5)' : 'rgba(255,167,38,0.5)'}`, borderRadius: 3, p: { xs: compactMobile ? 1.5 : 2, sm: 2.5 }, mb: { xs: compactMobile ? 2.5 : 3, sm: 3.5 } }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between">
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="subtitle2" fontWeight={700} color="text.primary">Promotion Readiness</Typography>
              <Chip
                label={promoReady ? 'READY' : promoStatus.replace(/_/g, ' ').toUpperCase()}
                size="small"
                sx={{ backgroundColor: promoReady ? 'rgba(102,187,106,0.2)' : 'rgba(255,167,38,0.2)', color: promoReady ? '#66BB6A' : '#FFA726', fontWeight: 600 }}
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">Latest report: {promoTimestamp}</Typography>
          </Stack>

          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', my: 1.5 }} />

          <Stack spacing={0.75}>
            <Typography variant="caption" color="text.disabled">Runtime</Typography>
            <Typography variant="body2" color="text.primary">
              {promoRuntime ? `${promoRuntime.lane || 'unknown'}:${promoRuntime.port || 'unknown'} • ${promoRuntime.commit ? promoRuntime.commit.slice(0, 7) : 'unknown'} • ${promoRuntime.repoPath || 'unknown'}` : 'Unavailable'}
            </Typography>
          </Stack>

          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', my: 1.5 }} />

          <Typography variant="caption" color="text.disabled" display="block" mb={0.75}>Blockers</Typography>
          {promoBlockers.length === 0 ? (
            <Typography variant="body2" color={promoReady ? '#66BB6A' : 'text.secondary'}>No blockers detected</Typography>
          ) : (
            <Stack spacing={0.5}>
              {promoBlockers.map((blocker, i) => (
                <Typography key={`${blocker}-${i}`} variant="body2" color="#FFA726">• {blocker}</Typography>
              ))}
            </Stack>
          )}
        </Box>
      )}

      <Box sx={{ backgroundColor: '#15151D', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 3, p: { xs: compactMobile ? 1.5 : 2, sm: 2.5 }, mb: { xs: compactMobile ? 2.5 : 3, sm: 3.5 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
          <Typography variant="subtitle2" fontWeight={700} color="text.primary">Execution & Nightly</Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              size="small"
              label={verificationLabel}
              sx={{
                height: 22,
                backgroundColor: promoReady ? 'rgba(102,187,106,0.18)' : 'rgba(255,167,38,0.2)',
                color: verificationColor,
                fontWeight: 600,
              }}
            />
            <Button size="small" variant="text" sx={{ textTransform: 'none' }} onClick={() => window.location.reload()}>
              Refresh snapshot
            </Button>
          </Stack>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.8} alignItems={{ xs: 'flex-start', sm: 'center' }} mb={1}>
          <Typography variant="caption" color="text.secondary">
            Last successful verification: {promoReady && verificationTimestamp ? new Date(verificationTimestamp).toLocaleString() : 'not available'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Latest report: {verificationTimestamp ? new Date(verificationTimestamp).toLocaleString() : 'not available'}{verificationAge ? ` (${verificationAge})` : ''}
          </Typography>
          <Button
            size="small"
            variant="text"
            sx={{ textTransform: 'none', minHeight: 24, px: 0.5, color: '#A8C7FA' }}
            onClick={openVerificationEvidence}
          >
            View verification evidence
          </Button>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'flex-start', sm: 'center' }}>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.disabled">Execution runs</Typography>
            <Typography variant="body2" color="text.primary">{executionRuns?.count ?? 0}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.disabled">Execution results</Typography>
            <Typography variant="body2" color="text.primary">{executionResults?.count ?? 0}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.disabled">Nightly status</Typography>
            <Typography variant="body2" color="text.primary">{nightlyStatus?.run?.status || 'unknown'}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.disabled">Latest briefing</Typography>
            <Typography variant="body2" color="text.primary">{nightlyStatus?.briefing?.name || 'none'}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.disabled">Tasks created (24h)</Typography>
            <Typography variant="body2" color="text.primary">{taskCreationAudit?.created24h ?? 0}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.disabled">Stale in-progress (3d+)</Typography>
            <Typography variant="body2" color={staleInProgress.length > 0 ? '#FFA726' : 'text.primary'}>{staleInProgress.length}</Typography>
          </Stack>
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.disabled">Last task created</Typography>
            <Typography variant="body2" color="text.primary">
              {taskCreationAudit?.lastCreated ? `${taskCreationAudit.lastCreated.actor || 'unknown'} via ${taskCreationAudit.lastCreated.source || 'unknown'}` : 'none'}
            </Typography>
            {taskCreationAudit?.lastCreated?.anomaly && (
              <Typography variant="caption" color="#FFA726">Anomaly flagged: {taskCreationAudit.lastCreated.recentCreatesInLastMinute || 0} tasks in &lt;1m</Typography>
            )}
          </Stack>
        </Stack>
        {oldestStaleInProgress && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={1.5} alignItems={{ xs: 'flex-start', sm: 'center' }}>
            <Typography variant="caption" color="#FFA726">
              Oldest stale: {oldestStaleInProgress.title} · Owner: {assignedLabel(oldestStaleInProgress.assignedAgent)}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              sx={{ textTransform: 'none', minHeight: 28, borderColor: 'rgba(255,167,38,0.45)', color: '#FFA726' }}
              onClick={() => oldestStaleInProgress.assignedAgent ? openAgentChat(oldestStaleInProgress.id, oldestStaleInProgress.assignedAgent) : openTask(oldestStaleInProgress.id)}
            >
              {oldestStaleInProgress.assignedAgent ? 'Escalate in Agents' : 'Open stale task'}
            </Button>
            <Button
              size="small"
              variant="text"
              sx={{ textTransform: 'none', minHeight: 28, color: '#A8C7FA' }}
              onClick={() => onNavigateWithFilter ? onNavigateWithFilter('projects', { priority: [], status: ['in-progress'], labels: [] }) : onNavigate('projects')}
            >
              View stale list
            </Button>
          </Stack>
        )}
      </Box>

      <Box sx={{ backgroundColor: '#15151D', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 3, p: { xs: compactMobile ? 1.5 : 2, sm: 2.5 }, mb: { xs: compactMobile ? 2.5 : 3, sm: 3.5 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
          <Typography variant="subtitle2" fontWeight={700} color="text.primary">Now Working</Typography>
          <Chip size="small" label={nowWorking?.label || 'No recent run'} sx={{ backgroundColor: nowWorking?.state === 'now_working' ? 'rgba(102,187,106,0.2)' : nowWorking?.state === 'waiting_on' ? 'rgba(255,167,38,0.2)' : 'rgba(255,255,255,0.08)', color: nowWorking?.state === 'now_working' ? '#66BB6A' : nowWorking?.state === 'waiting_on' ? '#FFA726' : 'text.secondary' }} />
        </Stack>
        {nowWorking ? (
          nowWorking.state === 'no_recent_run' ? (
            <Stack spacing={0.5}>
              <Typography variant="body2" color="text.disabled">No recent execution activity from product agents.</Typography>
              <Typography variant="caption" color="text.disabled">Now Working will populate automatically when a real run or agent reply occurs.</Typography>
            </Stack>
          ) : (
            <Stack spacing={0.45}>
              <Typography variant="body2" color="text.primary" fontWeight={700}>{nowWorking.taskTitle}</Typography>
              <Typography variant="caption" color="text.secondary">Agent: {assignedLabel(nowWorking.agentId)}</Typography>
              <Typography variant="caption" color="text.secondary">
                Latest evidence: {nowWorking.latestTimestamp ? new Date(nowWorking.latestTimestamp).toLocaleString() : 'none'} ({nowWorking.latestSource})
              </Typography>
              <Stack direction="row" spacing={0.8} mt={0.5}>
                <Button size="small" variant="outlined" onClick={() => openAgentChat(nowWorking.taskId, nowWorking.agentId)} sx={{ textTransform: 'none', minHeight: 28 }}>
                  Continue in Agents
                </Button>
                <Button size="small" variant="outlined" onClick={() => openTask(nowWorking.taskId)} sx={{ textTransform: 'none', minHeight: 28 }}>
                  Open task
                </Button>
              </Stack>
            </Stack>
          )
        ) : (
          <Typography variant="body2" color="text.disabled">No eligible assigned task with execution evidence.</Typography>
        )}
      </Box>

      <Box sx={{ backgroundColor: '#15151D', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 3, p: { xs: compactMobile ? 1.5 : 2, sm: 2.5 }, mb: { xs: compactMobile ? 2.5 : 3, sm: 3.5 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5}>
          <Typography variant="subtitle2" fontWeight={700} color="text.primary">Do This Now</Typography>
          <Typography variant="caption" color="text.secondary">Top {Math.min(topActions.length, 5)} actions</Typography>
        </Stack>

        {topActions.length === 0 ? (
          <Typography variant="body2" color="text.disabled">No active tasks to prioritize right now.</Typography>
        ) : (
          <Stack spacing={1.25}>
            {topActions.map(({ task, whyNow, blocker, nextGuidance, assigned, stateTruth, liveState }, idx) => (
              <Box key={`top-action-${task.id}`} sx={{ p: 1.25, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75} justifyContent="space-between" alignItems={{ sm: 'center' }}>
                  <Typography variant="body2" color="text.primary" fontWeight={700}>{idx + 1}. {task.title}</Typography>
                  <Chip size="small" label={`Owner: ${assigned}`} sx={{ backgroundColor: task.assignedAgent ? 'rgba(168,199,250,0.15)' : 'rgba(255,167,38,0.18)', color: task.assignedAgent ? '#A8C7FA' : '#FFA726' }} />
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block" mt={0.6}>[{stateTruth.stateLabel}] — {stateTruth.reason}</Typography>
                <Typography variant="caption" color="text.secondary" display="block" mt={0.4}>Last activity: {formatLiveActivityAge(liveState.lastActivityAt)} · Source: {liveState.activitySource}</Typography>
                <Typography variant="caption" color="text.secondary" display="block" mt={0.4}>Why now: {whyNow}</Typography>
                {liveState.staleAgain && <Typography variant="caption" color="#FFA726" display="block" mt={0.4}>[Stale again]</Typography>}
                {blocker && (
                  <Typography variant="caption" color="#FFA726" display="block" mt={0.45}>Blocker: {blocker}</Typography>
                )}
                <Typography variant="caption" color="#66BB6A" display="block" mt={0.45}>👉 Next: {nextGuidance}</Typography>

                <Stack direction="row" spacing={0.8} flexWrap="wrap" mt={1}>
                  <Button size="small" variant="outlined" onClick={() => openTask(task.id)} sx={{ textTransform: 'none', minHeight: 28 }}>
                    Open task
                  </Button>
                  {task.assignedAgent ? (
                    <Button size="small" variant="outlined" onClick={() => openAgentChat(task.id, task.assignedAgent)} sx={{ textTransform: 'none', minHeight: 28 }}>
                      Open agent chat
                    </Button>
                  ) : (
                    QUICK_ASSIGN_ORDER.map((agentId) => (
                      <Button key={`${task.id}-${agentId}`} size="small" variant="outlined" onClick={() => quickAssign(task.id, agentId)} sx={{ textTransform: 'none', minHeight: 28 }}>
                        Assign {assignedLabel(agentId)}
                      </Button>
                    ))
                  )}
                </Stack>
              </Box>
            ))}
          </Stack>
        )}
      </Box>

      {/* Stat cards */}
      <Box
        display="grid"
        gridTemplateColumns={{ xs: '1fr 1fr', sm: '1fr 1fr', md: 'repeat(5, minmax(0, 1fr))' }}
        gap={{ xs: compactMobile ? 1 : 1.25, sm: 2 }}
        mb={{ xs: compactMobile ? 2.5 : 4, sm: 4 }}
        sx={{ width: '100%' }}
      >
        {[
          { label: 'In Progress', value: inProgress.length, icon: <TrendingUpRounded sx={{ fontSize: 20, color: '#A8C7FA' }} />, filter: { priority: [], status: ['in-progress'], labels: [] } },
          { label: 'High Priority', value: highPriority.length, icon: <FlagRounded sx={{ fontSize: 20, color: '#EF5350' }} />, filter: { priority: ['high'], status: [], labels: [] } },
          { label: 'Open Tasks', value: activeTasks.length, icon: <RadioButtonUncheckedRounded sx={{ fontSize: 20, color: '#CFC6EA' }} />, filter: { priority: [], status: ['todo', 'in-progress', 'review', 'backlog'], labels: [] } },
          { label: 'Done', value: doneTasks.length, icon: <CheckCircleRounded sx={{ fontSize: 20, color: '#66BB6A' }} />, filter: { priority: [], status: ['done'], labels: [] } },
          { label: 'Stale (3d+)', value: staleInProgress.length, icon: <FlagRounded sx={{ fontSize: 20, color: '#FFA726' }} />, filter: { priority: [], status: ['in-progress'], labels: [] } },
        ].map(card => (
          <ButtonBase key={card.label} onClick={() => onNavigateWithFilter ? onNavigateWithFilter('projects', card.filter) : onNavigate('projects')} sx={{ borderRadius: 3, display: 'block', textAlign: 'left', width: '100%', minWidth: 0 }}>
            <Box sx={{ backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 3, p: { xs: compactMobile ? 1.25 : 1.75, sm: 2 }, minHeight: { xs: compactMobile ? 88 : 104, sm: 112 }, transition: 'border-color 0.15s', '&:hover': { borderColor: 'rgba(255,255,255,0.15)' } }}>
              <Box mb={{ xs: 0.5, sm: 1 }}>{card.icon}</Box>
              <Typography variant="h4" fontWeight={700} color="text.primary" lineHeight={1} sx={{ fontSize: { xs: compactMobile ? '1.15rem' : '1.4rem', sm: '2rem' } }}>{card.value}</Typography>
              <Typography variant="caption" color="text.secondary" mt={0.5} display="block" sx={{ fontSize: { xs: compactMobile ? '0.66rem' : '0.72rem', sm: '0.75rem' } }}>{card.label}</Typography>
            </Box>
          </ButtonBase>
        ))}
      </Box>

      <Box display="grid" gridTemplateColumns={{ xs: '1fr', md: '1fr 1fr' }} gap={3}>

        {/* Active tasks panel */}
        <Box sx={{ backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 3, p: 2.5 }}>
          <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <ViewKanbanRounded sx={{ fontSize: 18, color: '#A8C7FA' }} />
              <Typography variant="subtitle2" fontWeight={600} color="text.primary">Active Tasks</Typography>
            </Stack>
            <ButtonBase onClick={() => onNavigate('projects')} sx={{ borderRadius: 1.5 }}>
              <Typography variant="caption" color="#A8C7FA" sx={{ px: 1, py: 0.5 }}>View all →</Typography>
            </ButtonBase>
          </Box>

          {STATUS_ORDER.filter(s => s !== 'done').map(s => (
            <ButtonBase key={s} onClick={() => onNavigateWithFilter ? onNavigateWithFilter('projects', { priority: [], status: [s], labels: [] }) : onNavigate('projects')} sx={{ width: '100%', borderRadius: 1.5, display: 'block' }}>
              <Box display="flex" alignItems="center" justifyContent="space-between" py={0.75} px={0.5} sx={{ '&:hover': { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 1.5 } }}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: STATUS_COLORS[s] }} />
                  <Typography variant="body2" color="text.secondary">{STATUS_LABELS[s]}</Typography>
                </Stack>
                <Typography variant="body2" fontWeight={600} color="text.primary">{statusCounts[s] || 0}</Typography>
              </Box>
            </ButtonBase>
          ))}

          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', my: 2 }} />

          <Typography variant="caption" color="text.disabled" display="block" mb={1.25}>In Progress</Typography>
          {inProgress.length === 0 ? (
            <Typography variant="body2" color="text.disabled">Nothing in progress</Typography>
          ) : inProgress.map(t => {
            const live = deriveLiveState(t, snapshotTime || Date.now())
            return (
            <ButtonBase key={t.id} onClick={() => onNavigateWithFilter ? onNavigateWithFilter('projects', { priority: [], status: ['in-progress'], labels: [] }) : onNavigate('projects')} sx={{ width: '100%', borderRadius: 1.5, display: 'block', textAlign: 'left' }}>
              <Box display="flex" alignItems="flex-start" gap={1} mb={1.25} px={0.5} py={0.25} sx={{ '&:hover': { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 1.5 } }}>
                <FlagRounded sx={{ fontSize: 14, color: PRIORITY_COLORS[t.priority], mt: 0.3, flexShrink: 0 }} />
                <Box minWidth={0}>
                  <Typography variant="body2" color="text.primary" fontWeight={500} noWrap>{t.title}</Typography>
                  <Typography variant="caption" color="text.disabled">Owner: {live.owner} · Last activity: {formatLiveActivityAge(live.lastActivityAt, snapshotTime || Date.now())}</Typography>
                  <Typography variant="caption" color="text.disabled" display="block">Source: {live.activitySource}</Typography>
                  {live.staleAgain && <Typography variant="caption" color="#FFA726" display="block">[Stale again]</Typography>}
                </Box>
              </Box>
            </ButtonBase>
          )})}

          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', my: 2 }} />

          <Typography variant="caption" color="text.disabled" display="block" mb={1.25}>Needs Attention (stale 3d+)</Typography>
          {staleInProgress.length === 0 ? (
            <Typography variant="body2" color="text.disabled">No stale in-progress cards</Typography>
          ) : staleInProgress.slice(0, 3).map(t => (
            <ButtonBase key={`stale-${t.id}`} onClick={() => onNavigateWithFilter ? onNavigateWithFilter('projects', { priority: [], status: ['in-progress'], labels: [] }) : onNavigate('projects')} sx={{ width: '100%', borderRadius: 1.5, display: 'block', textAlign: 'left' }}>
              <Box display="flex" alignItems="flex-start" gap={1} mb={1.25} px={0.5} py={0.25} sx={{ '&:hover': { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 1.5 } }}>
                <FlagRounded sx={{ fontSize: 14, color: '#FFA726', mt: 0.3, flexShrink: 0 }} />
                <Box minWidth={0}>
                  <Typography variant="body2" color="text.primary" fontWeight={500} noWrap>{t.title}</Typography>
                  <Typography variant="caption" color="text.disabled">Last update: {(t.updatedAt || t.createdAt || '').slice(0, 10)}</Typography>
                </Box>
              </Box>
            </ButtonBase>
          ))}
        </Box>

        {/* Docs panel */}
        <Box sx={{ backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 3, p: 2.5 }}>
          <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <DescriptionRounded sx={{ fontSize: 18, color: '#CFC6EA' }} />
              <Typography variant="subtitle2" fontWeight={600} color="text.primary">Docs</Typography>
            </Stack>
            <ButtonBase onClick={() => onNavigate('docs')} sx={{ borderRadius: 1.5 }}>
              <Typography variant="caption" color="#A8C7FA" sx={{ px: 1, py: 0.5 }}>View all →</Typography>
            </ButtonBase>
          </Box>

          <Box display="flex" flexWrap="wrap" gap={1} mb={2.5}>
            {Object.entries(docsByCategory).map(([cat, count]) => (
              <Chip key={cat} label={`${cat} · ${count}`} size="small"
                sx={{ backgroundColor: 'rgba(207,198,234,0.1)', color: '#CFC6EA', fontSize: '0.72rem', height: 24, borderRadius: 1.5 }} />
            ))}
            {Object.keys(docsByCategory).length === 0 && (
              <Typography variant="body2" color="text.disabled">No docs yet</Typography>
            )}
          </Box>

          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mb: 2 }} />

          <Typography variant="caption" color="text.disabled" display="block" mb={1.25}>Recent</Typography>
          {recentDocs.length === 0 ? (
            <Typography variant="body2" color="text.disabled">No docs yet</Typography>
          ) : recentDocs.map((doc, i) => (
            <Box key={doc.id} mb={i < recentDocs.length - 1 ? 1.25 : 0}>
              <Typography variant="body2" color="text.primary" fontWeight={500} noWrap>{doc.title}</Typography>
              <Typography variant="caption" color="text.disabled">{doc.category} · {doc.date}</Typography>
            </Box>
          ))}
        </Box>

      </Box>
    </Box>
  )
}
