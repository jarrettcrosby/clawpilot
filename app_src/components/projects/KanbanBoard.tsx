'use client'

import { useState, useEffect, useRef, createContext, useContext, useCallback, useMemo } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import useMediaQuery from '@mui/material/useMediaQuery'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Chip from '@mui/material/Chip'
import Tooltip from '@mui/material/Tooltip'
import Popover from '@mui/material/Popover'
import MenuItem from '@mui/material/MenuItem'
import Menu from '@mui/material/Menu'
import IconButton from '@mui/material/IconButton'
import Switch from '@mui/material/Switch'
import FormControlLabel from '@mui/material/FormControlLabel'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import TextField from '@mui/material/TextField'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'
import Collapse from '@mui/material/Collapse'
import HourglassEmptyRounded from '@mui/icons-material/HourglassEmptyRounded'
import PauseCircleOutlined from '@mui/icons-material/PauseCircleOutlined'
import BlockRounded from '@mui/icons-material/BlockRounded'
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import MoreVertRounded from '@mui/icons-material/MoreVertRounded'
import {
  DndContext, DragEndEvent, DragStartEvent, DragOverlay,
  PointerSensor, TouchSensor, useSensor, useSensors, closestCorners
} from '@dnd-kit/core'
import KanbanColumn from './KanbanColumn'
import KanbanCard from './KanbanCard'
import CardDetailDrawer from './CardDetailDrawer'
import SearchBar from './SearchBar'
import FilterBar, { BoardFilter, emptyFilter, isFilterActive } from './FilterBar'
import ArchivedCardsView from './ArchivedCardsView'
import DeletedCardsView from './DeletedCardsView'
import NeedsAttentionPanel from './NeedsAttentionPanel'
import type { Task } from '@/lib/types'
import type { ConsolidationChecklistProposal, ConsolidationItem, ConsolidationMilestoneGroup, ConsolidationResponse, ConsolidationReviewPayload } from '@/lib/consolidation'
import { ASSIGNABLE_PRODUCT_AGENT_IDS, COLUMNS, PEOPLE } from '@/lib/types'
import { getTaskStartability, getAutoPickupEligibility } from '@/lib/taskState'
import { getTaskLastTouchedAt, isTaskStale } from '@/lib/staleTasks'
import { deriveNowWorking, deriveLatestEvidence } from '@/lib/nowWorking'

type BoardCtx = {
  updateTask: (t: Task) => void
  focusedTaskId: string | null
  setFocusedTaskId: (id: string) => void
  openDrawer: (id: string) => void
}
export const BoardContext = createContext<BoardCtx>({
  updateTask: () => {},
  focusedTaskId: null,
  setFocusedTaskId: () => {},
  openDrawer: () => {},
})
export const useBoardContext = () => useContext(BoardContext)

type Props = { externalFilter?: BoardFilter; onFilterChange?: (f: BoardFilter) => void }
type AutoPickupTaskEvent = CustomEvent<{ id?: string }>
type ConsolidationBuckets = { proposed: number; accepted: number; rejected: number; partially_accepted: number }

function assignedLabel(agent?: string) {
  if (!agent) return 'Unassigned'
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}

export default function KanbanBoard({ externalFilter, onFilterChange }: Props = {}) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null)
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const veryShortHeight = useMediaQuery('(max-height: 430px)')
  const isTouch = useMediaQuery('(pointer: coarse)')
  const isLandscape = useMediaQuery('(orientation: landscape)')
  // Portrait touch keeps full board; landscape touch uses compact tabs for reliable navigation.
  const compactBoardMode = veryShortHeight || (isTouch && isLandscape)
  const [activeColumn, setActiveColumn] = useState<string>(COLUMNS[0].status)
  const [archiveMode, setArchiveMode] = useState(false)
  const [archiveView, setArchiveView] = useState<'archived' | 'deleted'>('archived')
  const [startabilityFilter, setStartabilityFilter] = useState<'all' | 'startable'>('all')
  const [dispatchAnchor, setDispatchAnchor] = useState<HTMLElement | null>(null)
  const [dispatchTaskId, setDispatchTaskId] = useState<string | null>(null)
  const [autoPickupFeedback, setAutoPickupFeedback] = useState<{ dispatched: number; skipped: number; reasons: Record<string, number> } | null>(null)
  const [actionabilityGuardNotice, setActionabilityGuardNotice] = useState<string | null>(null)
  const [actionabilityHint, setActionabilityHint] = useState<{ taskId: string; message: string; missing: string[] } | null>(null)
  const [autoPickupAudit, setAutoPickupAudit] = useState<{ taskId: string; title: string; agentId: string; ts: string; status: 'dispatched' | 'skipped' }[]>([])
  const [showFullAudit, setShowFullAudit] = useState(false)
  const [autoPickupMode, setAutoPickupMode] = useState<'off' | 'on'>('off')
  const [autoPickupLastRunAt, setAutoPickupLastRunAt] = useState<string | null>(null)
  const [autoPickupLastDispatchCount, setAutoPickupLastDispatchCount] = useState<number>(0)
  const [autoPickupDryRun, setAutoPickupDryRun] = useState<{ dispatchCount: number; skipCount: number; plan?: { dispatches?: { taskId: string; agentId: string }[]; skipped?: { taskId: string; reasons: string[] }[] } } | null>(null)
  const [showDryRunSkips, setShowDryRunSkips] = useState(false)
  const [executeOnceOpen, setExecuteOnceOpen] = useState(false)
  const [executeOnceResult, setExecuteOnceResult] = useState<{ dispatchCount: number; skipCount: number; dispatches: { taskId: string; agentId: string }[] } | null>(null)
  const [executeOnceAudit, setExecuteOnceAudit] = useState<{ ts: string; dispatchCount: number; skipCount: number; dispatches: { taskId: string; agentId: string }[] }[]>([])
  const [threadRows, setThreadRows] = useState<any[]>([])
  const [resolveStaleOpen, setResolveStaleOpen] = useState(false)
  const [resolveMode, setResolveMode] = useState<'todo' | 'waiting'>('todo')
  const [waitingReason, setWaitingReason] = useState('')
  const [resolvingStale, setResolvingStale] = useState(false)
  const autoPickupRunningRef = useRef(false)
  const isCompact = useMediaQuery('(max-width:900px)')
  const isMobile = useMediaQuery('(max-width:600px)')
  const [showLegends, setShowLegends] = useState(false)
  const [actionsAnchor, setActionsAnchor] = useState<HTMLElement | null>(null)
  const [showMoreAgentReady, setShowMoreAgentReady] = useState(false)
  const [staleFocusOnly, setStaleFocusOnly] = useState(false)

  useEffect(() => {
    if (!archiveMode) setArchiveView('archived')
  }, [archiveMode])
  const [internalFilter, setInternalFilter] = useState<BoardFilter>(emptyFilter())
  const [consolidation, setConsolidation] = useState<ConsolidationResponse | null>(null)
  const [consolidating, setConsolidating] = useState(false)
  const consolidationProposals = consolidation?.proposals

  // Merge external (dashboard) filter with internal — external takes priority when set
  const filter: BoardFilter = externalFilter && isFilterActive(externalFilter) ? externalFilter : internalFilter

  function handleFilterChange(f: BoardFilter) {
    setInternalFilter(f)
    onFilterChange?.(f)
  }

  function clearFilter() {
    setInternalFilter(emptyFilter())
    onFilterChange?.(emptyFilter())
  }

  const drawerTask = tasks.find(t => t.id === drawerTaskId) || null
  const drawerOpen = drawerTaskId !== null

  const startableCount = tasks.filter(t => !t.archived && getTaskStartability(t).status === 'STARTABLE').length
  const staleTasks = [...tasks]
    .filter((task) => isTaskStale(task))
    .sort((a, b) => {
      const aTouched = Date.parse(getTaskLastTouchedAt(a))
      const bTouched = Date.parse(getTaskLastTouchedAt(b))
      return aTouched - bTouched
    })
    .slice(0, 5)
  const dispatchAgents = PEOPLE.filter(p => ASSIGNABLE_PRODUCT_AGENT_IDS.includes(p.id as typeof ASSIGNABLE_PRODUCT_AGENT_IDS[number]))
  const autoPickupEligible = tasks.filter(t => getAutoPickupEligibility(t).eligible)
  const autoPickupAgentCounts = autoPickupEligible.reduce<Record<string, number>>((acc, t) => {
    const agentId = t.execution?.assignedAgent || t.assignedAgent || 'unassigned'
    acc[agentId] = (acc[agentId] || 0) + 1
    return acc
  }, {})
  const nowWorking = useMemo(() => deriveNowWorking(tasks), [tasks])
  const staleInProgressCandidates = useMemo(() => {
    const nowMs = Date.now()
    const thresholdMs = 72 * 60 * 60 * 1000
    const threadLatestByTask: Record<string, number> = {}
    for (const row of threadRows || []) {
      const taskId = String(row?.taskId || '').trim()
      if (!taskId) continue
      const ts = Date.parse(String(row?.lastMessageAt || row?.updatedAt || row?.createdAt || ''))
      if (!Number.isFinite(ts)) continue
      threadLatestByTask[taskId] = Math.max(threadLatestByTask[taskId] || 0, ts)
    }

    return tasks.filter((task) => {
      if (task.archived) return false
      if (task.status !== 'in-progress') return false
      const latestEvidence = deriveLatestEvidence(task).ts
      const threadTs = threadLatestByTask[String(task.id)] || null
      const evidenceAge = latestEvidence ? nowMs - latestEvidence : Number.POSITIVE_INFINITY
      const threadAge = threadTs ? nowMs - threadTs : Number.POSITIVE_INFINITY
      return evidenceAge > thresholdMs && threadAge > thresholdMs
    })
  }, [tasks, threadRows])
  const staleInProgressCandidateIds = useMemo(() => new Set(staleInProgressCandidates.map(task => String(task.id))), [staleInProgressCandidates])

  useEffect(() => {
    if (staleInProgressCandidates.length === 0 && staleFocusOnly) setStaleFocusOnly(false)
  }, [staleInProgressCandidates.length, staleFocusOnly])


  const visibleTasks = tasks.filter(t => {
    if (t.archived) return false
    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const matchSearch = t.title.toLowerCase().includes(q) || t.desc?.toLowerCase().includes(q) || t.tags?.some(tag => tag.toLowerCase().includes(q))
      if (!matchSearch) return false
    }
    // Status filter
    if (filter.status.length > 0) {
      if (filter.status.includes('active')) {
        if (t.status === 'done') return false
      } else if (!filter.status.includes(t.status)) return false
    }
    // Priority filter
    if (filter.priority.length > 0 && !filter.priority.includes(t.priority)) return false
    // Label filter
    if (filter.labels.length > 0 && !filter.labels.every(l => t.tags?.includes(l))) return false
    // Startability filter
    if (startabilityFilter === 'startable') {
      if (getTaskStartability(t).status !== 'STARTABLE') return false
    }
    if (staleFocusOnly && !staleInProgressCandidateIds.has(String(t.id))) return false
    return true
  })

  function handleArchiveCard(archived: Task) {
    setTasks(prev => prev.map(t => t.id === archived.id ? archived : t))
    setDrawerTaskId(null)
  }

  function handleRestored(restored: Task) {
    setTasks(prev => prev.map(t => t.id === restored.id ? restored : t))
  }

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 10 } })
  const sensors = useSensors(...(isTouch ? [touchSensor] : [pointerSensor, touchSensor]))

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    Promise.all([
      fetch('/api/tasks', { signal: controller.signal }).then(r => r.json()).catch(() => []),
      fetch('/api/agents/threads', { signal: controller.signal }).then(r => r.json()).catch(() => []),
    ])
      .then(([taskData, threadData]) => {
        setTasks(Array.isArray(taskData) ? taskData : [])
        if (Array.isArray(threadData)) setThreadRows(threadData)
        else if (Array.isArray((threadData as { threads?: any[] })?.threads)) setThreadRows((threadData as { threads?: any[] }).threads || [])
        else setThreadRows([])
      })
      .catch(() => {
        // Fail open so the UI never spins forever on network/client hiccups
        setTasks([])
        setThreadRows([])
      })
      .finally(() => {
        clearTimeout(timeout)
        setLoading(false)
      })

    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [])

  const updateTask = useCallback((updated: Task) => {
    setTasks(prev => prev.map(t => t.id === updated.id ? updated : t))
  }, [])

  const openDrawer = useCallback((id: string) => {
    setFocusedTaskId(id)
    setDrawerTaskId(id)
  }, [])

  function continueInAgents(taskId: string, agentId?: string) {
    window.location.hash = 'agents'
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('open-agent-task', { detail: { taskId, agentId: agentId || '' } }))
    }, 120)
  }

  async function applyResolveStaleBatch() {
    if (staleInProgressCandidates.length === 0) {
      setResolveStaleOpen(false)
      return
    }
    if (resolveMode === 'waiting' && waitingReason.trim().length < 3) return

    setResolvingStale(true)
    const note = resolveMode === 'todo'
      ? 'Resolved stale in-progress via batch action: moved to todo.'
      : `Resolved stale in-progress via batch action: waiting on ${waitingReason.trim()}.`

    const patches = staleInProgressCandidates.map(async (task) => {
      const nowIso = new Date().toISOString()
      const body = {
        id: task.id,
        status: resolveMode === 'todo' ? 'todo' : 'in-progress',
        _execution: {
          assignedAgent: task.execution?.assignedAgent || task.assignedAgent || undefined,
          executionStatus: 'awaiting_input',
          lastUpdatedAt: nowIso,
          latestExecutionNote: note,
        },
        _comment: resolveMode === 'todo'
          ? 'Batch stale resolution: moved to todo for fresh re-start.'
          : `Batch stale resolution: waiting on ${waitingReason.trim()}.`,
        _actor: 'ClawPilot',
      }
      const r = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) return null
      return await r.json()
    })

    const results = (await Promise.all(patches)).filter(Boolean) as Task[]
    if (results.length > 0) {
      const map = new Map(results.map((t) => [String(t.id), t]))
      setTasks((prev) => prev.map((t) => map.get(String(t.id)) || t))
    }

    setResolvingStale(false)
    setResolveStaleOpen(false)
    setWaitingReason('')
    setResolveMode('todo')
  }

  async function dispatchToAgent(taskId: string, agentId: string) {
    setDispatchAnchor(null)
    setDispatchTaskId(null)
    const r = await fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: taskId,
          assignedAgent: agentId,
          status: 'in-progress',
          _execution: {
            assignedAgent: agentId,
          executionStatus: 'queued',
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          latestExecutionNote: `Dispatched to ${agentId}.`,
        },
        _actor: 'ClawPilot'
      }),
    })
    const updated = await r.json()
    if (r.ok) updateTask(updated)
  }

  async function runAutoPickupOnce(mode: 'manual' | 'background' = 'manual') {
    if (mode === 'background' && autoPickupRunningRef.current) return
    if (mode === 'background') autoPickupRunningRef.current = true
    const reasons: Record<string, number> = {}
    const eligibleTasks = tasks.filter(t => {
      const eligibility = getAutoPickupEligibility(t)
      if (!eligibility.eligible) {
        eligibility.reasons.forEach(r => { reasons[r] = (reasons[r] || 0) + 1 })
        return false
      }
      return true
    })

    let dispatched = 0
    const auditEntries: { taskId: string; title: string; agentId: string; ts: string; status: 'dispatched' | 'skipped' }[] = []
    await Promise.all(eligibleTasks.map(async (t) => {
      const agentId = t.execution?.assignedAgent || t.assignedAgent
      if (!agentId) {
        reasons['no-assigned-agent'] = (reasons['no-assigned-agent'] || 0) + 1
        auditEntries.push({ taskId: t.id, title: t.title, agentId: 'unassigned', ts: new Date().toISOString(), status: 'skipped' })
        return
      }
      const r = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: t.id,
          assignedAgent: agentId,
          status: 'in-progress',
          _execution: {
            assignedAgent: agentId,
            executionStatus: 'running',
            startedAt: t.execution?.startedAt || new Date().toISOString(),
            lastUpdatedAt: new Date().toISOString(),
            latestExecutionNote: `${mode === 'background' ? 'Background auto-pickup' : 'Auto-pickup'} queued for ${agentId}.`,
          },
          _actor: 'ClawPilot'
        }),
      })
      if (r.ok) {
        const updated = await r.json()
        updateTask(updated)
        dispatched += 1
        auditEntries.push({ taskId: t.id, title: t.title, agentId, ts: new Date().toISOString(), status: 'dispatched' })
      }
    }))

    const skipped = tasks.length - dispatched
    if (mode === 'manual') setAutoPickupFeedback({ dispatched, skipped, reasons })
    if (auditEntries.length > 0) setAutoPickupAudit(prev => [...auditEntries, ...prev].slice(0, 10))
    if (mode === 'background') {
      setAutoPickupLastRunAt(new Date().toISOString())
      setAutoPickupLastDispatchCount(dispatched)
      autoPickupRunningRef.current = false
    }
  }


  async function runAutoPickupDryRun() {
    const r = await fetch('/api/auto-pickup/dry-run')
    if (!r.ok) return
    const data = await r.json()
    setAutoPickupDryRun(data)
  }

  async function runExecuteOnce() {
    const r = await fetch('/api/auto-pickup/execute-once', { method: 'POST' })
    if (!r.ok) return
    const data = await r.json()
    const result = {
      dispatchCount: data.dispatchCount,
      skipCount: data.skipCount,
      dispatches: data.dispatches || [],
    }
    setExecuteOnceResult(result)
    setExecuteOnceAudit(prev => [{ ts: new Date().toISOString(), ...result }, ...prev].slice(0, 5))
  }

  useEffect(() => {
    if (autoPickupMode !== 'on') return
    const interval = setInterval(() => {
      runAutoPickupOnce('background')
    }, 30000)
    return () => clearInterval(interval)
  }, [autoPickupMode, tasks])

  useEffect(() => {
    function onOpenTask(e: Event) {
      const event = e as AutoPickupTaskEvent
      const id = event.detail?.id
      if (!id) return
      setPendingOpenId(id)
    }
    window.addEventListener('open-task', onOpenTask)
    return () => window.removeEventListener('open-task', onOpenTask)
  }, [])

  useEffect(() => {
    if (!pendingOpenId) return
    const exists = tasks.find(t => t.id === pendingOpenId)
    if (!exists) return
    openDrawer(pendingOpenId)
    setPendingOpenId(null)
  }, [pendingOpenId, tasks, openDrawer])

  const closeDrawer = useCallback(() => {
    setDrawerTaskId(null)
  }, [])

  async function proposeConsolidation() {
    setConsolidating(true)
    setConsolidation(null)
    try {
      const r = await fetch('/api/consolidate')
      const out = await r.json()
      if (!r.ok) throw new Error(out?.error || 'Consolidation failed')
      setConsolidation(out)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setConsolidation({ error: message })
    } finally {
      setConsolidating(false)
    }
  }

  async function refreshConsolidation() {
    const r = await fetch('/api/consolidate')
    const out = await r.json()
    if (r.ok) setConsolidation(out)
  }

  async function updateReviewDecision(payload: ConsolidationReviewPayload) {
    await fetch('/api/consolidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    await refreshConsolidation()
  }

  async function resetReviewDecisions() {
    await updateReviewDecision({ action: 'reset' })
  }

  function summarizeDecisions() {
    const buckets: ConsolidationBuckets = { proposed: 0, accepted: 0, rejected: 0, partially_accepted: 0 }
    if (!consolidation?.proposals) return buckets

    const allItems: ConsolidationItem[] = [
      ...consolidation.proposals.remain_standalone,
      ...consolidation.proposals.become_comments,
      ...consolidation.proposals.become_checklist_items.map((it: ConsolidationChecklistProposal) => it.task),
      ...consolidation.proposals.merge_into_milestone.flatMap((m: ConsolidationMilestoneGroup) => m.items || []),
    ]
    allItems.forEach(it => {
      const state = it.decision || 'proposed'
      if (state === 'accepted') buckets.accepted += 1
      else if (state === 'rejected') buckets.rejected += 1
      else buckets.proposed += 1
    })
    const groupPartial = consolidation.proposals.merge_into_milestone.filter((m: ConsolidationMilestoneGroup) => m.decision === 'partially_accepted').length
    buckets.partially_accepted = groupPartial
    return buckets
  }

  function decisionChip(state: string) {
    const colors: Record<string, { bg: string; fg: string; border: string }> = {
      proposed: { bg: 'rgba(255,255,255,0.08)', fg: 'rgba(255,255,255,0.6)', border: 'rgba(255,255,255,0.12)' },
      accepted: { bg: 'rgba(102,187,106,0.2)', fg: '#66BB6A', border: 'rgba(102,187,106,0.4)' },
      rejected: { bg: 'rgba(239,83,80,0.2)', fg: '#EF5350', border: 'rgba(239,83,80,0.4)' },
      partially_accepted: { bg: 'rgba(255,167,38,0.2)', fg: '#FFA726', border: 'rgba(255,167,38,0.4)' },
      applied: { bg: 'rgba(168,199,250,0.2)', fg: '#A8C7FA', border: 'rgba(168,199,250,0.4)' },
    }
    const c = colors[state] || colors.proposed
    return (
      <Chip
        size="small"
        label={state.replace('_', ' ')}
        sx={{ backgroundColor: c.bg, color: c.fg, border: `1px solid ${c.border}`, textTransform: 'capitalize' }}
      />
    )
  }

  // Keyboard navigation
  useEffect(() => {
    function getColumnTasks(colStatus: string) {
      return tasks.filter(t => t.status === colStatus)
    }

    function getFocusedInfo() {
      if (!focusedTaskId) return null
      const task = tasks.find(t => t.id === focusedTaskId)
      if (!task) return null
      const colIndex = COLUMNS.findIndex(c => c.status === task.status)
      const colTasks = getColumnTasks(task.status)
      const rowIndex = colTasks.findIndex(t => t.id === focusedTaskId)
      return { task, colIndex, rowIndex, colTasks }
    }

    function focusCard(id: string) {
      setFocusedTaskId(id)
      // If drawer is open, follow navigation
      setDrawerTaskId(prev => prev !== null ? id : null)
      setTimeout(() => {
        document.getElementById('kanban-card-' + id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, 50)
    }

    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const isTyping = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
      if (isTyping) return

      const info = getFocusedInfo()

      switch (e.key) {
        case 'j':
        case 'J': {
          e.preventDefault()
          if (!info) {
            // Focus first card
            const first = tasks.find(t => t.status === COLUMNS[0].status)
            if (first) focusCard(first.id)
            return
          }
          const next = info.colTasks[info.rowIndex + 1]
          if (next) focusCard(next.id)
          break
        }
        case 'k':
        case 'K': {
          e.preventDefault()
          if (!info) return
          const prev = info.colTasks[info.rowIndex - 1]
          if (prev) focusCard(prev.id)
          break
        }
        case 'ArrowRight': {
          if (!info) return
          e.preventDefault()
          const nextCol = COLUMNS[info.colIndex + 1]
          if (!nextCol) return
          const nextColTasks = getColumnTasks(nextCol.status)
          if (nextColTasks.length === 0) return
          const target = nextColTasks[Math.min(info.rowIndex, nextColTasks.length - 1)]
          if (target) focusCard(target.id)
          break
        }
        case 'ArrowLeft': {
          if (!info) return
          e.preventDefault()
          const prevCol = COLUMNS[info.colIndex - 1]
          if (!prevCol) return
          const prevColTasks = getColumnTasks(prevCol.status)
          if (prevColTasks.length === 0) return
          const target = prevColTasks[Math.min(info.rowIndex, prevColTasks.length - 1)]
          if (target) focusCard(target.id)
          break
        }
        case 'Enter': {
          if (!focusedTaskId) return
          e.preventDefault()
          if (drawerOpen) {
            closeDrawer()
          } else {
            openDrawer(focusedTaskId)
          }
          break
        }
        case 'Escape': {
          if (drawerOpen) {
            closeDrawer()
          } else if (isFilterActive(filter) || searchQuery) {
            clearFilter()
            setSearchQuery('')

          } else {
            setFocusedTaskId(null)
          }
          break
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tasks, focusedTaskId, drawerOpen, openDrawer, closeDrawer])

  function handleDragStart(event: DragStartEvent) {
    setActiveTask(tasks.find(t => t.id === event.active.id) || null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null)
    const { active, over } = event
    if (!over) return
    const dragged = tasks.find(t => t.id === active.id)
    if (!dragged) return
    const targetStatus = COLUMNS.find(c => c.status === over.id)?.status
      || tasks.find(t => t.id === over.id)?.status
    if (!targetStatus || targetStatus === dragged.status) return
    setTasks(prev => prev.map(t => t.id === active.id ? { ...t, status: targetStatus } : t))
    fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: active.id, status: targetStatus }),
    })
      .then(r => r.json())
      .then((updated: Task & { actionabilityGuard?: { blocked?: boolean; message?: string; missing?: string[] } }) => {
        updateTask(updated)
        if (updated?.actionabilityGuard?.blocked) {
          const message = updated.actionabilityGuard.message || 'Missing: owner and next action'
          setActionabilityGuardNotice(`👉 ${message}`)
          setActionabilityHint({ taskId: String(updated.id || active.id), message, missing: updated.actionabilityGuard.missing || [] })
          openDrawer(String(updated.id || active.id))
        }
      })
      .catch(() => {
        setTasks(prev => prev.map(t => t.id === active.id ? { ...t, status: dragged.status } : t))
      })
  }

  if (loading) return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <CircularProgress size={32} sx={{ color: '#A8C7FA' }} />
    </Box>
  )

  return (
    <BoardContext.Provider value={{ updateTask, focusedTaskId, setFocusedTaskId, openDrawer }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, backgroundColor: '#0F0F13', overflowY: { xs: 'auto', md: 'hidden' }, overflowX: 'hidden', WebkitOverflowScrolling: 'touch' }}>
        <Box sx={{ px: { xs: 2, md: 4 }, pt: { xs: 2, md: 3 }, pb: 2, flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                <Typography variant="h5" fontWeight={700} color="text.primary">Projects</Typography>
                {autoPickupMode === 'on' && (
                  <Chip size="small" label="Session auto-pickup active" sx={{ height: 20, fontSize: '0.6rem', borderRadius: 1, backgroundColor: 'rgba(102,187,106,0.2)', color: '#66BB6A', border: 'none' }} />
                )}
                <Typography variant="body2" color="text.disabled">{archiveMode ? 'Archive' : `${visibleTasks.length} task${visibleTasks.length !== 1 ? 's' : ''}${isFilterActive(filter) ? ' (filtered)' : ''}${staleFocusOnly ? ' · stale only' : ''}`}</Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
                <Chip
                  size="small"
                  label={startabilityFilter === 'startable' ? `Startable only · ${startableCount}` : `All tasks · ${startableCount} startable`}
                  onClick={() => setStartabilityFilter(prev => prev === 'startable' ? 'all' : 'startable')}
                  sx={{
                    height: 24,
                    fontSize: '0.7rem',
                    borderRadius: 1.5,
                    cursor: 'pointer',
                    backgroundColor: startabilityFilter === 'startable' ? 'rgba(102,187,106,0.2)' : 'rgba(255,255,255,0.06)',
                    color: startabilityFilter === 'startable' ? '#66BB6A' : 'text.secondary',
                    border: startabilityFilter === 'startable' ? '1px solid rgba(102,187,106,0.35)' : '1px solid rgba(255,255,255,0.08)',
                    '&:hover': { borderColor: startabilityFilter === 'startable' ? '#66BB6A' : 'rgba(255,255,255,0.25)' },
                  }}
                />
                {isCompact ? (
                  <>
                    <IconButton size="small" onClick={(e) => setActionsAnchor(e.currentTarget)} sx={{ color: 'text.secondary' }}>
                      <MoreVertRounded sx={{ fontSize: 18 }} />
                    </IconButton>
                    <Menu
                      anchorEl={actionsAnchor}
                      open={Boolean(actionsAnchor)}
                      onClose={() => setActionsAnchor(null)}
                      PaperProps={{ sx: { backgroundColor: '#232330', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 2 } }}
                    >
                      <MenuItem
                        onClick={() => {
                          setInternalFilter({ status: [], priority: [], labels: ['needs-quality', 'governance-flag'] })
                          setArchiveMode(false)
                          setActionsAnchor(null)
                        }}
                      >
                        Governance Issues
                      </MenuItem>
                      <MenuItem onClick={() => { proposeConsolidation(); setActionsAnchor(null) }} disabled={consolidating}>
                        {consolidating ? 'Checking…' : 'Propose Consolidation'}
                      </MenuItem>
                      <MenuItem onClick={() => { setShowLegends(s => !s); setActionsAnchor(null) }}>
                        {showLegends ? 'Hide legends' : 'Show legends'}
                      </MenuItem>
                    </Menu>
                  </>
                ) : (
                  <>
                    <Button
                      variant="text"
                      size="small"
                      onClick={() => {
                        setInternalFilter({ status: [], priority: [], labels: ['needs-quality', 'governance-flag'] })
                        setArchiveMode(false)
                      }}
                      sx={{ textTransform: 'none', fontSize: '0.7rem', color: 'text.secondary' }}
                    >
                      Governance Issues
                    </Button>
                    <Button
                      variant="text"
                      size="small"
                      onClick={proposeConsolidation}
                      disabled={consolidating}
                      sx={{ textTransform: 'none', fontSize: '0.7rem', color: 'text.secondary' }}
                    >
                      {consolidating ? 'Checking…' : 'Propose Consolidation'}
                    </Button>
                    <Button variant="text" size="small" onClick={() => setShowLegends(s => !s)} sx={{ textTransform: 'none', fontSize: '0.7rem' }}>
                      {showLegends ? 'Hide legends' : 'Show legends'}
                    </Button>
                  </>
                )}
              </Box>
            </Box>
            <Collapse in={showLegends || !isCompact}>
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                <Typography variant="caption" color="text.disabled" sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: '0.65rem' }}>State</Typography>
                <Chip size="small" label="needs input" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(255,167,38,0.2)', color: '#FFA726', border: 'none' }} />
                <Chip size="small" label="blocked" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(239,83,80,0.2)', color: '#EF5350', border: 'none' }} />
                <Chip size="small" label="in progress" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(168,199,250,0.2)', color: '#A8C7FA', border: 'none' }} />
                <Typography variant="caption" color="text.disabled" sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: '0.65rem', ml: 0.5 }}>Outcome</Typography>
                <Chip size="small" label="blocked" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(239,83,80,0.2)', color: '#EF5350', border: 'none' }} />
                <Chip size="small" label="completed" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(102,187,106,0.2)', color: '#66BB6A', border: 'none' }} />
                <Typography variant="caption" color="text.disabled" sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: '0.65rem', ml: 0.5 }}>Execution</Typography>
                <Chip size="small" icon={<HourglassEmptyRounded sx={{ fontSize: 12 }} />} label="queued" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(255,167,38,0.2)', color: '#FFA726', border: 'none', '& .MuiChip-icon': { color: '#FFA726', ml: 0.3 } }} />
                <Chip size="small" icon={<PauseCircleOutlined sx={{ fontSize: 12 }} />} label="running" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(168,199,250,0.2)', color: '#A8C7FA', border: 'none', '& .MuiChip-icon': { color: '#A8C7FA', ml: 0.3 } }} />
                <Chip size="small" icon={<BlockRounded sx={{ fontSize: 12 }} />} label="blocked" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(239,83,80,0.2)', color: '#EF5350', border: 'none', '& .MuiChip-icon': { color: '#EF5350', ml: 0.3 } }} />
                <Chip size="small" icon={<HelpOutlineRounded sx={{ fontSize: 12 }} />} label="awaiting input" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.6)', border: 'none', '& .MuiChip-icon': { color: 'rgba(255,255,255,0.6)', ml: 0.3 } }} />
                <Chip size="small" icon={<CheckCircleRounded sx={{ fontSize: 12 }} />} label="completed" sx={{ height: 20, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(102,187,106,0.2)', color: '#66BB6A', border: 'none', '& .MuiChip-icon': { color: '#66BB6A', ml: 0.3 } }} />
              </Stack>
            </Collapse>
          </Box>
          
              <Box sx={{ mt: 2 }}>
                <Dialog open={executeOnceOpen} onClose={() => setExecuteOnceOpen(false)} maxWidth="xs" fullWidth>
                  <DialogTitle>Run server-side execute-once?</DialogTitle>
                  <DialogContent>
                    <Typography variant="body2" color="text.secondary">
                      This will dispatch all currently eligible tasks using the server-side execute-once endpoint. Dry-run is separate.
                    </Typography>
                  </DialogContent>
                  <DialogActions>
                    <Button onClick={() => setExecuteOnceOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button
                      variant="contained"
                      onClick={async () => {
                        await runExecuteOnce()
                        setExecuteOnceOpen(false)
                      }}
                      sx={{ textTransform: 'none', backgroundColor: '#A8C7FA', color: '#001D36' }}
                    >
                      Execute once
                    </Button>
                  </DialogActions>
                </Dialog>

                <Dialog open={resolveStaleOpen} onClose={() => setResolveStaleOpen(false)} maxWidth="sm" fullWidth>
                  <DialogTitle>Resolve stale in-progress work</DialogTitle>
                  <DialogContent>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>
                      Apply one explicit action to {staleInProgressCandidates.length} stale card{staleInProgressCandidates.length === 1 ? '' : 's'} (&gt;72h with no recent thread or execution evidence).
                    </Typography>
                    <Stack spacing={1}>
                      <Button
                        variant={resolveMode === 'todo' ? 'contained' : 'outlined'}
                        onClick={() => setResolveMode('todo')}
                        sx={{ textTransform: 'none', justifyContent: 'flex-start' }}
                      >
                        Move to todo
                      </Button>
                      <Button
                        variant={resolveMode === 'waiting' ? 'contained' : 'outlined'}
                        onClick={() => setResolveMode('waiting')}
                        sx={{ textTransform: 'none', justifyContent: 'flex-start' }}
                      >
                        Mark waiting on
                      </Button>
                      {resolveMode === 'waiting' && (
                        <TextField
                          size="small"
                          label="Waiting reason (required)"
                          value={waitingReason}
                          onChange={(e) => setWaitingReason(e.target.value)}
                          placeholder="e.g., waiting on owner approval"
                        />
                      )}
                    </Stack>
                  </DialogContent>
                  <DialogActions>
                    <Button onClick={() => setResolveStaleOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button
                      variant="contained"
                      disabled={resolvingStale || staleInProgressCandidates.length === 0 || (resolveMode === 'waiting' && waitingReason.trim().length < 3)}
                      onClick={applyResolveStaleBatch}
                      sx={{ textTransform: 'none', backgroundColor: '#A8C7FA', color: '#001D36' }}
                    >
                      Apply to stale tasks
                    </Button>
                  </DialogActions>
                </Dialog>

            <Snackbar
              open={Boolean(autoPickupFeedback)}
              autoHideDuration={5000}
              onClose={() => setAutoPickupFeedback(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            >
              <Alert severity="info" variant="filled" onClose={() => setAutoPickupFeedback(null)} sx={{ fontSize: '0.75rem' }}>
                Auto-pickup run: {autoPickupFeedback?.dispatched ?? 0} dispatched · {autoPickupFeedback?.skipped ?? 0} skipped
                {autoPickupFeedback && Object.keys(autoPickupFeedback.reasons).length > 0 && (
                  <span> — {Object.entries(autoPickupFeedback.reasons).map(([k, v]) => `${k}:${v}`).join(', ')}</span>
                )}
              </Alert>
            </Snackbar>
            <Snackbar
              open={Boolean(actionabilityGuardNotice)}
              autoHideDuration={4500}
              onClose={() => setActionabilityGuardNotice(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            >
              <Alert severity="warning" variant="filled" onClose={() => setActionabilityGuardNotice(null)} sx={{ fontSize: '0.75rem' }}>
                {actionabilityGuardNotice}
              </Alert>
            </Snackbar>
            <SearchBar query={searchQuery} onSearch={setSearchQuery} archiveMode={archiveMode} onToggleArchive={() => setArchiveMode(m => !m)} />
            {!archiveMode && !isMobile && staleInProgressCandidates.length > 0 && (
              <Box sx={{ mt: 1.1, p: { xs: 0.85, md: 1.1 }, borderRadius: 2, backgroundColor: 'rgba(255,167,38,0.08)', border: '1px solid rgba(255,167,38,0.28)' }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.8} alignItems={{ sm: 'center' }} justifyContent="space-between">
                  <Typography variant="caption" color="#FFA726" sx={{ fontSize: '0.68rem' }}>
                    {staleInProgressCandidates.length} stale in-progress card{staleInProgressCandidates.length === 1 ? '' : 's'} detected (&gt;72h, no recent thread/evidence).
                  </Typography>
                  <Stack direction="row" spacing={0.75}>
                    <Button
                      size="small"
                      variant={staleFocusOnly ? 'contained' : 'outlined'}
                      onClick={() => setStaleFocusOnly((prev) => !prev)}
                      sx={{
                        textTransform: 'none',
                        minHeight: 24,
                        borderColor: 'rgba(255,167,38,0.5)',
                        color: staleFocusOnly ? '#001D36' : '#FFA726',
                        backgroundColor: staleFocusOnly ? '#FFA726' : 'transparent',
                      }}
                    >
                      {staleFocusOnly ? 'Showing stale only' : 'Focus stale only'}
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => setResolveStaleOpen(true)}
                      sx={{ textTransform: 'none', minHeight: 24, borderColor: 'rgba(255,167,38,0.5)', color: '#FFA726' }}
                    >
                      👉 Resolve stale work
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            )}
            {!archiveMode && !isMobile && (
              <Box sx={{ mt: 1.25, p: { xs: 0.85, md: 1.2 }, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 1 }} alignItems={{ sm: 'center' }} justifyContent="space-between">
                  <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.6rem', letterSpacing: 1.4 }}>NOW WORKING</Typography>
                  <Chip
                    size="small"
                    label={nowWorking?.label || 'No recent run'}
                    sx={{
                      height: 20,
                      fontSize: '0.62rem',
                      borderRadius: 1,
                      backgroundColor: nowWorking?.state === 'now_working' ? 'rgba(102,187,106,0.2)' : nowWorking?.state === 'waiting_on' ? 'rgba(255,167,38,0.2)' : 'rgba(255,255,255,0.08)',
                      color: nowWorking?.state === 'now_working' ? '#66BB6A' : nowWorking?.state === 'waiting_on' ? '#FFA726' : 'text.secondary',
                      border: 'none',
                    }}
                  />
                </Stack>
                {nowWorking ? (
                  nowWorking.state === 'no_recent_run' ? (
                    <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem' }}>No recent execution activity from product agents.</Typography>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem' }}>This panel will show task context after a real run or agent reply.</Typography>
                    </Stack>
                  ) : (
                    <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                      <Typography variant="body2" color="text.primary" sx={{ fontSize: '0.8rem', fontWeight: 600 }}>{nowWorking.taskTitle}</Typography>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem' }}>Agent: {assignedLabel(nowWorking.agentId)}</Typography>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem' }}>
                        Latest evidence: {nowWorking.latestTimestamp ? new Date(nowWorking.latestTimestamp).toLocaleString() : 'none'} ({nowWorking.latestSource})
                      </Typography>
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.25 }}>
                        <Button size="small" variant="text" onClick={() => continueInAgents(nowWorking.taskId, nowWorking.agentId)} sx={{ textTransform: 'none', fontSize: '0.68rem', minWidth: 0 }}>
                          Continue in Agents
                        </Button>
                        <Button size="small" variant="text" onClick={() => openDrawer(nowWorking.taskId)} sx={{ textTransform: 'none', fontSize: '0.68rem', minWidth: 0 }}>
                          Open task
                        </Button>
                      </Stack>
                    </Stack>
                  )
                ) : (
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem', mt: 0.4, display: 'block' }}>No eligible assigned task with execution evidence.</Typography>
                )}
              </Box>
            )}
            {process.env.NODE_ENV === 'development' && !archiveMode && staleTasks.length > 0 && (
              <NeedsAttentionPanel tasks={staleTasks} onUpdate={updateTask} onOpenTask={openDrawer} />
            )}
            {!archiveMode && !isMobile && (
              <Box sx={{ mt: 1.5, p: { xs: 0.75, md: 1.25 }, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 1 }} alignItems={{ sm: 'center' }} justifyContent="space-between" flexWrap="wrap">
                  <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.6rem', letterSpacing: 1.4 }}>AGENT-READY</Typography>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.68rem' }}>
                      Top {Math.min(startableCount, isCompact && !showMoreAgentReady ? 2 : 3)} startable
                    </Typography>
                    <Button size="small" variant="outlined" onClick={() => runAutoPickupOnce('manual')} sx={{ textTransform: 'none', fontSize: '0.65rem', py: 0.25, px: 1 }}>
                      Run once
                    </Button>
                  </Stack>
                </Stack>
                <Stack spacing={0.4} sx={{ mt: 0.5 }}>
                  <Box sx={{ mb: 0.25, p: 0.5, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.04)' }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem' }}>Session auto-pickup</Typography>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <FormControlLabel
                          control={<Switch size="small" checked={autoPickupMode === 'on'} onChange={() => setAutoPickupMode(m => m === 'on' ? 'off' : 'on')} />}
                          label={autoPickupMode === 'on' ? 'On' : 'Off'}
                          sx={{ m: 0, '& .MuiTypography-root': { fontSize: '0.6rem', color: 'text.disabled' } }}
                        />
                        <Button size="small" variant="text" onClick={runAutoPickupDryRun} sx={{ textTransform: 'none', fontSize: '0.6rem' }}>
                          Preview dry-run
                        </Button>
                        <Button size="small" variant="text" onClick={() => setExecuteOnceOpen(true)} sx={{ textTransform: 'none', fontSize: '0.6rem' }}>
                          Execute once…
                        </Button>
                      </Stack>
                    </Stack>
                    <Stack spacing={0.25} sx={{ mt: 0.25 }}>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>Runs only while this tab is open</Typography>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>Eligible now: {autoPickupEligible.length}</Typography>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>
                        Last run: {autoPickupLastRunAt ? new Date(autoPickupLastRunAt).toLocaleString() : '—'} · dispatched {autoPickupLastDispatchCount}
                      </Typography>
                      {Object.keys(autoPickupAgentCounts).length > 0 && (
                        <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>
                          Routed to: {Object.entries(autoPickupAgentCounts).map(([agent, count]) => `${agent}(${count})`).join(' · ')}
                        </Typography>
                      )}
                      {autoPickupDryRun && (
                        <Stack spacing={0.25}>
                          <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>
                            Dry-run: {autoPickupDryRun.dispatchCount} dispatch · {autoPickupDryRun.skipCount} skipped
                          </Typography>
                          {executeOnceResult && (
                            <Stack spacing={0.25}>
                              <Typography variant="caption" color="#66BB6A" sx={{ fontSize: '0.62rem' }}>
                                Execute-once: {executeOnceResult.dispatchCount} dispatched · {executeOnceResult.skipCount} skipped
                              </Typography>
                              {(executeOnceResult.dispatches || []).slice(0, 3).map(d => {
                                const task = tasks.find(t => t.id === d.taskId)
                                return (
                                  <Typography key={`${d.taskId}-${d.agentId}`} variant="caption" color="#66BB6A" sx={{ fontSize: '0.62rem' }}>
                                    {task?.title || d.taskId} → {d.agentId}
                                  </Typography>
                                )
                              })}
                            </Stack>
                          )}
                          {executeOnceAudit.length > 0 && (
                            <Box sx={{ mt: 0.5, p: 0.5, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.04)' }}>
                              <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem' }}>Recent execute-once runs</Typography>
                              <Stack spacing={0.25} sx={{ mt: 0.25 }}>
                                {executeOnceAudit.slice(0, 3).map((entry) => (
                                  <Typography key={entry.ts} variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>
                                    {new Date(entry.ts).toLocaleString()} · {entry.dispatchCount} dispatched · {entry.skipCount} skipped
                                  </Typography>
                                ))}
                                {executeOnceAudit[0]?.dispatches?.slice(0, 2).map(d => {
                                  const task = tasks.find(t => t.id === d.taskId)
                                  return (
                                    <Typography key={`${d.taskId}-${d.agentId}-audit`} variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>
                                      {task?.title || d.taskId} → {d.agentId}
                                    </Typography>
                                  )
                                })}
                              </Stack>
                            </Box>
                          )}
                          {(autoPickupDryRun.plan?.dispatches || []).slice(0, 3).map((d) => {
                            const task = tasks.find(t => t.id === d.taskId)
                            return (
                              <Typography key={`${d.taskId}-${d.agentId}`} variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>
                                {task?.title || d.taskId} → {d.agentId}
                              </Typography>
                            )
                          })}
                          {autoPickupDryRun.skipCount > 0 && (
                            <Stack spacing={0.25}>
                              <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>
                                Skips: {(() => {
                                  const reasons = (autoPickupDryRun.plan?.skipped || []).flatMap(s => s.reasons || [])
                                  const counts = reasons.reduce<Record<string, number>>((acc, r) => {
                                    acc[r] = (acc[r] || 0) + 1
                                    return acc
                                  }, {})
                                  return Object.entries(counts).slice(0, 3).map(([reason, count]) => `${reason}(${count})`).join(' · ') || '—'
                                })()}
                              </Typography>
                              {autoPickupDryRun.plan?.skipped && autoPickupDryRun.plan.skipped.length > 0 && (
                                <Button size="small" variant="text" onClick={() => setShowDryRunSkips(s => !s)} sx={{ textTransform: 'none', fontSize: '0.6rem', alignSelf: 'flex-start' }}>
                                  {showDryRunSkips ? 'Hide skipped examples' : 'View skipped examples'}
                                </Button>
                              )}
                              {showDryRunSkips && (
                                <Stack spacing={0.25}>
                                  {(autoPickupDryRun.plan?.skipped || []).slice(0, 3).map(s => {
                                    const task = tasks.find(t => t.id === s.taskId)
                                    const primaryReason = s.reasons?.[0] || 'unspecified'
                                    return (
                                      <Typography key={`${s.taskId}-${primaryReason}`} variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem' }}>
                                        {task?.title || s.taskId} — {primaryReason}
                                      </Typography>
                                    )
                                  })}
                                </Stack>
                              )}
                            </Stack>
                          )}
                        </Stack>
                      )}
                    </Stack>
                  </Box>
                  {autoPickupAudit.length > 0 && (
                    <Box sx={{ mb: 0.25, p: 0.5, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.04)' }}>
                      <Stack direction="row" alignItems="center" justifyContent="space-between">
                        <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem' }}>Recent auto-pickup</Typography>
                        {autoPickupAudit.length > (isCompact ? 2 : 4) && (
                          <Button size="small" variant="text" onClick={() => setShowFullAudit(s => !s)} sx={{ textTransform: 'none', fontSize: '0.6rem' }}>
                            {showFullAudit ? 'Show less' : 'View full audit'}
                          </Button>
                        )}
                      </Stack>
                      <Stack spacing={0.25} sx={{ mt: 0.25 }}>
                        {autoPickupAudit.slice(0, showFullAudit ? 10 : (isCompact ? 2 : 4)).map(entry => (
                          <Typography key={`${entry.taskId}-${entry.ts}`} variant="caption" color={entry.status === 'dispatched' ? '#66BB6A' : 'text.disabled'} sx={{ fontSize: '0.62rem' }}>
                            {entry.status === 'dispatched' ? 'Dispatched' : 'Skipped'}: {entry.title} → {entry.agentId} · {new Date(entry.ts).toLocaleString()}
                          </Typography>
                        ))}
                      </Stack>
                    </Box>
                  )}
                  {[...tasks]
                    .filter(t => !t.archived && getTaskStartability(t).status === 'STARTABLE')
                    .sort((a, b) => {
                      const prioRank: Record<string, number> = { high: 3, medium: 2, low: 1 }
                      const prioDiff = (prioRank[b.priority] || 0) - (prioRank[a.priority] || 0)
                      if (prioDiff !== 0) return prioDiff
                      const aDue = a.dueDate ? new Date(a.dueDate + 'T00:00:00').getTime() : Number.MAX_SAFE_INTEGER
                      const bDue = b.dueDate ? new Date(b.dueDate + 'T00:00:00').getTime() : Number.MAX_SAFE_INTEGER
                      if (aDue !== bDue) return aDue - bDue
                      const aUpdated = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
                      const bUpdated = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
                      return bUpdated - aUpdated
                    })
                    .slice(0, isCompact && !showMoreAgentReady ? 2 : 3)
                    .map(t => {
                      const eligibility = getAutoPickupEligibility(t)
                      return (
                      <Box key={t.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" color="text.primary" sx={{ fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</Typography>
                          <Typography variant="caption" color={eligibility.eligible ? '#66BB6A' : 'text.disabled'} sx={{ fontSize: '0.65rem' }}>
                            {eligibility.eligible ? 'Auto-pickup eligible' : `Not eligible: ${eligibility.reasons.join(' · ')}`}
                          </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', gap: 0.25 }}>
                          <Button size="small" variant="text" onClick={(e) => { setDispatchTaskId(t.id); setDispatchAnchor(e.currentTarget); }} sx={{ textTransform: 'none', fontSize: '0.68rem', minWidth: 0 }}>
                            Dispatch
                          </Button>
                          <Button size="small" variant="text" onClick={() => openDrawer(t.id)} sx={{ textTransform: 'none', fontSize: '0.68rem', minWidth: 0 }}>
                            Open
                          </Button>
                        </Box>
                      </Box>
                      )
                    })}
                  {startableCount === 0 && (
                    <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.65rem' }}>No startable tasks yet.</Typography>
                  )}
                  {isCompact && startableCount > 2 && (
                    <Button size="small" variant="text" onClick={() => setShowMoreAgentReady(s => !s)} sx={{ textTransform: 'none', fontSize: '0.65rem', alignSelf: 'flex-start', mt: 0.25 }}>
                      {showMoreAgentReady ? 'Show less' : 'Show more'}
                    </Button>
                  )}
                </Stack>
              </Box>
            )}
            <Popover
              open={Boolean(dispatchAnchor)}
              anchorEl={dispatchAnchor}
              onClose={() => { setDispatchAnchor(null); setDispatchTaskId(null) }}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
              PaperProps={{ sx: { backgroundColor: '#232330', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 2, p: 0.5, minWidth: 160 } }}
            >
              {dispatchAgents.map(agent => (
                <MenuItem key={agent.id} onClick={() => dispatchTaskId && dispatchToAgent(dispatchTaskId, agent.id)} sx={{ fontSize: '0.8rem' }}>{agent.name}</MenuItem>
              ))}
            </Popover>
            {archiveMode ? (
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <Button size="small" variant={archiveView === 'archived' ? 'contained' : 'outlined'} onClick={() => setArchiveView('archived')} sx={{ textTransform: 'none' }}>
                  Archived cards
                </Button>
                <Button size="small" variant={archiveView === 'deleted' ? 'contained' : 'outlined'} onClick={() => setArchiveView('deleted')} sx={{ textTransform: 'none' }}>
                  Deleted cards
                </Button>
              </Stack>
            ) : (
              <FilterBar filter={filter} onChange={handleFilterChange} onClear={clearFilter} />
            )}
          </Box>
        </Box>

        {consolidation && (
          <Box sx={{ px: { xs: 2, md: 4 }, pt: 2 }}>
            <Card sx={{ p: 1.25, mb: 2, backgroundColor: '#0F1720', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', maxHeight: { xs: '60vh', md: '55vh' } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                <Typography variant="subtitle2">Consolidation proposal (manual)</Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip label="Review only" size="small" sx={{ backgroundColor: 'rgba(168,199,250,0.18)', color: '#A8C7FA', border: '1px solid rgba(168,199,250,0.35)' }} />
                  <Button size="small" variant="text" onClick={resetReviewDecisions} sx={{ textTransform: 'none' }}>Reset staged decisions</Button>
                  <Button size="small" variant="text" onClick={() => setConsolidation(null)} sx={{ textTransform: 'none' }}>Return to board</Button>
                </Stack>
              </Box>
              {consolidation.error ? (
                <Typography color="error">{consolidation.error}</Typography>
              ) : consolidationProposals ? (
                <Box sx={{ mt: 1, overflowY: 'auto', pr: 0.5 }}>
                  <Stack spacing={1} sx={{ mb: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      Decisions are staged only — no changes are applied yet. States: {consolidation.decisionModel?.states?.join(' · ') || 'proposed / accepted / rejected / partially_accepted / applied'}
                    </Typography>
                    <Box sx={{ p: 1, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.04)' }}>
                      {(() => {
                        const summary = summarizeDecisions()
                        return (
                          <Box sx={{ mb: 1, p: 1, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="space-between">
                              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                <Chip size="small" label={`Proposed ${summary.proposed}`} sx={{ backgroundColor: 'rgba(255,255,255,0.08)', color: 'text.secondary' }} />
                                <Chip size="small" label={`Accepted ${summary.accepted}`} sx={{ backgroundColor: 'rgba(102,187,106,0.2)', color: '#66BB6A' }} />
                                <Chip size="small" label={`Rejected ${summary.rejected}`} sx={{ backgroundColor: 'rgba(239,83,80,0.2)', color: '#EF5350' }} />
                                {summary.partially_accepted > 0 && (
                                  <Chip size="small" label={`Partial ${summary.partially_accepted}`} sx={{ backgroundColor: 'rgba(255,167,38,0.2)', color: '#FFA726' }} />
                                )}
                              </Stack>
                              <Typography variant="caption" color="text.secondary">
                                Last updated: {consolidation.reviewState?.updatedAt ? new Date(consolidation.reviewState.updatedAt).toLocaleString() : '—'}
                              </Typography>
                            </Stack>
                          </Box>
                        )
                      })()}
                      <Stack spacing={0.5}>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Typography variant="caption" color="text.secondary">Group Accept:</Typography>
                          <Typography variant="caption" color="text.secondary">accepts all items in the group (review-only)</Typography>
                          <Tooltip title="Marks all items in the group as accepted. No changes are applied.">
                            <HelpOutlineRounded sx={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }} />
                          </Tooltip>
                        </Stack>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Typography variant="caption" color="text.secondary">Group Reject:</Typography>
                          <Typography variant="caption" color="text.secondary">rejects the group recommendation</Typography>
                          <Tooltip title="Marks the group recommendation as rejected. No changes are applied.">
                            <HelpOutlineRounded sx={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }} />
                          </Tooltip>
                        </Stack>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Typography variant="caption" color="text.secondary">Item Accept:</Typography>
                          <Typography variant="caption" color="text.secondary">accepts a single item</Typography>
                          <Tooltip title="Marks the individual item as accepted. No changes are applied.">
                            <HelpOutlineRounded sx={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }} />
                          </Tooltip>
                        </Stack>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Typography variant="caption" color="text.secondary">Item Reject:</Typography>
                          <Typography variant="caption" color="text.secondary">rejects a single item</Typography>
                          <Tooltip title="Marks the individual item as rejected. No changes are applied.">
                            <HelpOutlineRounded sx={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }} />
                          </Tooltip>
                        </Stack>
                      </Stack>
                    </Box>
                  </Stack>

                  <Stack spacing={2}>
                    <Box>
                      <Typography variant="overline" color="text.disabled">Merge into milestones</Typography>
                      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1 }} />
                      {consolidationProposals.merge_into_milestone.map((m: ConsolidationMilestoneGroup) => (
                        <Box key={m.milestone} sx={{ mb: 1.5, p: 1.25, borderRadius: 2, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: 'rgba(255,255,255,0.02)' }}>
                          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                            <Box>
                              <Typography variant="body2" fontWeight={600}>{m.milestone}</Typography>
                              <Typography variant="caption" color="text.secondary">{m.reason}</Typography>
                            </Box>
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              {decisionChip(m.decision || 'proposed')}
                              <Button size="small" variant="contained" sx={{ textTransform: 'none', backgroundColor: '#A8C7FA', color: '#001D36' }}
                                onClick={() => updateReviewDecision({ scope: 'group', action: 'accept', groupId: m.groupId, itemIds: m.items.map((i: ConsolidationItem) => i.id) })}
                              >Group Accept</Button>
                              <Button size="small" variant="outlined" color="error" sx={{ textTransform: 'none' }}
                                onClick={() => updateReviewDecision({ scope: 'group', action: 'reject', groupId: m.groupId, itemIds: m.items.map((i: ConsolidationItem) => i.id) })}
                              >Group Reject</Button>
                            </Stack>
                          </Stack>
                          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', my: 1 }} />
                          <Stack spacing={0.75}>
                            {m.items.map((it: ConsolidationItem) => (
                              <Box key={it.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                                <Box>
                                  <Typography variant="body2">{it.title}</Typography>
                                  <Typography variant="caption" color="text.secondary">{it.reason}</Typography>
                                </Box>
                                <Stack direction="row" spacing={0.5} alignItems="center">
                                  {decisionChip(it.decision || 'proposed')}
                                  <Button size="small" variant="text" sx={{ textTransform: 'none' }}
                                    onClick={() => updateReviewDecision({ scope: 'item', action: 'accept', itemId: it.id, groupId: m.groupId })}
                                  >Accept</Button>
                                  <Button size="small" variant="text" color="error" sx={{ textTransform: 'none' }}
                                    onClick={() => updateReviewDecision({ scope: 'item', action: 'reject', itemId: it.id, groupId: m.groupId })}
                                  >Reject</Button>
                                </Stack>
                              </Box>
                            ))}
                          </Stack>
                        </Box>
                      ))}
                    </Box>

                    <Box>
                      <Typography variant="overline" color="text.disabled">Remain standalone</Typography>
                      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1 }} />
                      <Stack spacing={0.75}>
                        {consolidationProposals.remain_standalone.map((it: ConsolidationItem) => (
                          <Box key={it.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 0.75, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.02)' }}>
                            <Box>
                              <Typography variant="body2">{it.title}</Typography>
                              <Typography variant="caption" color="text.secondary">{it.reason}</Typography>
                            </Box>
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              {decisionChip(it.decision || 'proposed')}
                              <Button size="small" variant="text" sx={{ textTransform: 'none' }}
                                onClick={() => updateReviewDecision({ scope: 'item', action: 'accept', itemId: it.id })}
                              >Accept</Button>
                              <Button size="small" variant="text" color="error" sx={{ textTransform: 'none' }}
                                onClick={() => updateReviewDecision({ scope: 'item', action: 'reject', itemId: it.id })}
                              >Reject</Button>
                            </Stack>
                          </Box>
                        ))}
                      </Stack>
                    </Box>

                    <Box>
                      <Typography variant="overline" color="text.disabled">Become comments</Typography>
                      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1 }} />
                      <Stack spacing={0.75}>
                        {consolidationProposals.become_comments.map((it: ConsolidationItem) => (
                          <Box key={it.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 0.75, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.02)' }}>
                            <Box>
                              <Typography variant="body2">{it.title}</Typography>
                              <Typography variant="caption" color="text.secondary">{it.reason}</Typography>
                            </Box>
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              {decisionChip(it.decision || 'proposed')}
                              <Button size="small" variant="text" sx={{ textTransform: 'none' }}
                                onClick={() => updateReviewDecision({ scope: 'item', action: 'accept', itemId: it.id })}
                              >Accept</Button>
                              <Button size="small" variant="text" color="error" sx={{ textTransform: 'none' }}
                                onClick={() => updateReviewDecision({ scope: 'item', action: 'reject', itemId: it.id })}
                              >Reject</Button>
                            </Stack>
                          </Box>
                        ))}
                      </Stack>
                    </Box>

                    {consolidationProposals.become_checklist_items.length > 0 && (
                      <Box>
                        <Typography variant="overline" color="text.disabled">Become checklist items</Typography>
                        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1 }} />
                        <Stack spacing={0.75}>
                          {consolidationProposals.become_checklist_items.map((it: ConsolidationChecklistProposal) => (
                            <Box key={it.task.id} sx={{ p: 0.9, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.06)', backgroundColor: 'rgba(255,255,255,0.02)' }}>
                              <Typography variant="body2">{it.task.title}</Typography>
                              <Typography variant="caption" color="text.secondary">{it.task.reason} → {it.parentTitle}</Typography>
                              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                                {decisionChip(it.task.decision || 'proposed')}
                                <Button size="small" variant="text" sx={{ textTransform: 'none' }}
                                  onClick={() => updateReviewDecision({ scope: 'item', action: 'accept', itemId: it.task.id })}
                                >Accept</Button>
                                <Button size="small" variant="text" color="error" sx={{ textTransform: 'none' }}
                                  onClick={() => updateReviewDecision({ scope: 'item', action: 'reject', itemId: it.task.id })}
                                >Reject</Button>
                              </Stack>
                            </Box>
                          ))}
                        </Stack>
                      </Box>
                    )}
                  </Stack>
                </Box>
              ) : (
                <Typography color="text.secondary">No consolidation proposals available.</Typography>
              )}
            </Card>
          </Box>
        )}

        {archiveMode ? (
          archiveView === 'archived' ? (
            <ArchivedCardsView query={searchQuery} onRestored={handleRestored} />
          ) : (
            <DeletedCardsView query={searchQuery} />
          )
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <Box sx={{ px: { xs: 1.5, md: 4 }, pt: 2.5, pb: 1, flex: { xs: '0 0 auto', md: 1 }, minHeight: { xs: 300, md: 0 }, display: 'flex' }}>
              <Box sx={{
                display: 'flex', gap: 2, flex: 1, minHeight: 0,
                overflowX: 'auto', overflowY: 'hidden', pb: 2,
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-x',
                overscrollBehaviorX: 'contain',
                '&::-webkit-scrollbar': { height: 6 },
                '&::-webkit-scrollbar-thumb': { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3 },
              }}>
                {COLUMNS.map(col => (
                  <KanbanColumn key={col.status} status={col.status} label={col.label} color={col.color}
                    tasks={visibleTasks.filter(t => t.status === col.status)} />
                ))}
              </Box>
            </Box>
            <DragOverlay>
              {activeTask ? <KanbanCard task={activeTask} /> : null}
            </DragOverlay>
          </DndContext>
        )}
      </Box>

      {/* Centrally managed drawer — follows keyboard nav */}
      {drawerTask && (
        <CardDetailDrawer
          task={drawerTask}
          open={drawerOpen}
          onClose={closeDrawer}
          onUpdate={updateTask}
          onArchive={handleArchiveCard}
          actionabilityHint={actionabilityHint && actionabilityHint.taskId === drawerTask.id ? actionabilityHint : null}
        />
      )}
    </BoardContext.Provider>
  )
}
