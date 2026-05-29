'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Stack from '@mui/material/Stack'
import Card from '@mui/material/Card'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import Chip from '@mui/material/Chip'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import ButtonBase from '@mui/material/ButtonBase'
import Divider from '@mui/material/Divider'
import CircularProgress from '@mui/material/CircularProgress'
import Tooltip from '@mui/material/Tooltip'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded'
import type { Task } from '@/lib/types'
import type { ConsolidationChecklistProposal, ConsolidationItem, ConsolidationMilestoneGroup, ConsolidationResponse, ConsolidationReviewPayload } from '@/lib/consolidation'
import { getAutoPickupEligibility } from '@/lib/taskState'
import { deriveNextActionGuidance, deriveStateTruth } from '@/lib/workItemModel'
import { deriveLiveState, formatLiveActivityAge } from '@/lib/liveState'

type Agent = { id: string; name: string; owner: string; status: string; summary: string; executionAgentId?: string; kind?: 'product' | 'orchestrator' }
type Assignment = { taskId: string; agentId: string; updatedAt: string }
type ThreadMessage = { id: string; role: 'user' | 'agent' | 'system'; text: string; createdAt: string; taskId?: string }
type ThreadModel = {
  threadId: string
  agentId: string
  createdAt: string | null
  updatedAt: string | null
  taskId: string | null
  status: string
  tags: string[]
  messages: ThreadMessage[]
}
type ConsolidationBuckets = { proposed: number; accepted: number; rejected: number; partially_accepted: number }

export default function AgentsSection() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [docsBootstrapMsg, setDocsBootstrapMsg] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [, setThread] = useState<ThreadModel | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [composer, setComposer] = useState('')
  const [consolidation, setConsolidation] = useState<ConsolidationResponse | null>(null)
  const [consolidating, setConsolidating] = useState(false)
  const [autoBindNotice, setAutoBindNotice] = useState('')
  const [chatScope, setChatScope] = useState<'single' | 'all'>('single')
  const [showTools, setShowTools] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/agents').then(r => r.json()),
      fetch('/api/tasks').then(r => r.json()),
      fetch('/api/agents/assignments').then(r => r.json()),
    ]).then(([a, t, m]) => {
      const agentList = a?.agents || []
      setAgents(agentList)
      setTasks(Array.isArray(t) ? t : [])
      setAssignments(m?.assignments || [])
      if (!selectedAgentId && agentList[0]?.id) setSelectedAgentId(agentList[0].id)
    }).catch(() => {})
  }, [selectedAgentId])

  async function refreshTasks() {
    const t = await fetch('/api/tasks').then(r => r.json())
    setTasks(Array.isArray(t) ? t : [])
    const m = await fetch('/api/agents/assignments').then(r => r.json())
    setAssignments(m?.assignments || [])
  }

  useEffect(() => {
    if (!selectedAgentId) return
    const params = new URLSearchParams({ agentId: selectedAgentId })
    if (!selectedTaskId) {
      setThread(null)
      setMessages([])
      return
    }
    params.set('taskId', selectedTaskId)
    fetch(`/api/agents/threads?${params.toString()}`)
      .then(r => r.json())
      .then(out => {
        setThread(out || null)
        setMessages(Array.isArray(out?.messages) ? out.messages : [])
      })
      .catch(() => {
        setThread(null)
        setMessages([])
        setAutoBindNotice('Failed to load task thread. Re-select the task or try again.')
      })
  }, [selectedAgentId, selectedTaskId])

  const openTasks = useMemo(() => tasks.filter(t => t.status !== 'done' && !t.archived), [tasks])
  const assignedCount = useMemo(() => assignments.length, [assignments])
  const selectedAgent = agents.find(a => a.id === selectedAgentId) || null
  const selectedTask = selectedTaskId ? tasks.find(t => t.id === selectedTaskId) : null
  const selectedTaskTruth = selectedTask ? deriveStateTruth({
    workItem: selectedTask.workItem,
    checklist: selectedTask.checklist,
    executionStatus: selectedTask.execution?.executionStatus,
    executionUpdatedAt: selectedTask.execution?.lastUpdatedAt,
    updatedAt: selectedTask.updatedAt,
    createdAt: selectedTask.createdAt,
  }) : null
  const selectedTaskNext = selectedTask ? deriveNextActionGuidance({
    stateTruth: selectedTaskTruth || undefined,
    workItem: selectedTask.workItem,
    checklist: selectedTask.checklist,
    executionStatus: selectedTask.execution?.executionStatus,
    executionUpdatedAt: selectedTask.execution?.lastUpdatedAt,
    updatedAt: selectedTask.updatedAt,
    createdAt: selectedTask.createdAt,
  }) : null
  const productAgents = useMemo(() => agents, [agents])
  const chatAgents = useMemo(() => agents, [agents])
  const agentTasks = useMemo(() => tasks
    .filter(t => t.assignedAgent === selectedAgentId && t.status !== 'done' && !t.archived)
    .sort((a, b) => {
      const aliveA = deriveLiveState(a)
      const aliveB = deriveLiveState(b)
      if (aliveA.staleAgain !== aliveB.staleAgain) return aliveA.staleAgain ? -1 : 1
      const at = Date.parse(String(aliveA.lastActivityAt || a.updatedAt || a.createdAt || 0)) || 0
      const bt = Date.parse(String(aliveB.lastActivityAt || b.updatedAt || b.createdAt || 0)) || 0
      return bt - at
    }), [tasks, selectedAgentId])
  const chatTaskOptions = useMemo(() => {
    const selectedExtra = selectedTaskId
      ? tasks.find(t => t.id === selectedTaskId && !t.assignedAgent && t.status !== 'done' && !t.archived)
      : null
    const base = !selectedExtra || agentTasks.some(t => t.id === selectedExtra.id)
      ? agentTasks
      : [selectedExtra, ...agentTasks]
    const prioritized = [...base].sort((a, b) => {
      const aIsSelectedUnassigned = !!(selectedExtra && a.id === selectedExtra.id)
      const bIsSelectedUnassigned = !!(selectedExtra && b.id === selectedExtra.id)
      if (aIsSelectedUnassigned !== bIsSelectedUnassigned) return aIsSelectedUnassigned ? -1 : 1
      const aliveA = deriveLiveState(a)
      const aliveB = deriveLiveState(b)
      if (aliveA.staleAgain !== aliveB.staleAgain) return aliveA.staleAgain ? -1 : 1
      const at = Date.parse(String(aliveA.lastActivityAt || a.updatedAt || a.createdAt || 0)) || 0
      const bt = Date.parse(String(aliveB.lastActivityAt || b.updatedAt || b.createdAt || 0)) || 0
      return bt - at
    })
    return prioritized.slice(0, 12)
  }, [agentTasks, selectedTaskId, tasks])
  const hiddenChatTaskCount = Math.max(0, agentTasks.length - chatTaskOptions.filter(t => t.assignedAgent === selectedAgentId).length)
  const claimEligibility = selectedTask ? getAutoPickupEligibility(selectedTask) : null
  const canClaim = !!(selectedTask && claimEligibility?.eligible)
  const consolidationProposals = consolidation?.proposals
  const getAgentForTask = useCallback((taskId?: string | null) => {
    if (!taskId) return ''
    const task = tasks.find(t => t.id === taskId)
    return task?.assignedAgent || ''
  }, [tasks])

  useEffect(() => {
    if (!selectedAgentId) return
    if (!selectedTaskId) return
    const stillValid = tasks.some(t => t.id === selectedTaskId && (t.assignedAgent === selectedAgentId || !t.assignedAgent))
    if (!stillValid) {
      setSelectedTaskId(null)
      setAutoBindNotice('Task context cleared: select a task explicitly before chatting.')
    }
  }, [selectedAgentId, selectedTaskId, tasks])

  useEffect(() => {
    if (!selectedAgentId) return
    if (selectedTaskId) return
    if (agentTasks.length === 0) return
    setSelectedTaskId(agentTasks[0].id)
  }, [selectedAgentId, selectedTaskId, agentTasks])

  useEffect(() => {
    function onOpenAgentTask(e: Event) {
      const event = e as CustomEvent<{ taskId?: string; agentId?: string }>
      const taskId = event.detail?.taskId
      const agentId = event.detail?.agentId || getAgentForTask(taskId)
      if (!taskId) return
      if (agentId) setSelectedAgentId(agentId)
      setSelectedTaskId(taskId)
      setChatScope('single')
    }
    window.addEventListener('open-agent-task', onOpenAgentTask)
    return () => window.removeEventListener('open-agent-task', onOpenAgentTask)
  }, [getAgentForTask])

  async function assign(taskId: string, agentId: string) {
    const r = await fetch('/api/agents/assignments', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, agentId }),
    })
    const out = await r.json()
    if (r.ok) {
      setAssignments(out.assignments || [])
      const patch = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: taskId, assignedAgent: agentId, _actor: 'ClawPilot' }),
      })
      const updated = await patch.json().catch(() => null)
      if (patch.ok && updated?.id) setTasks(prev => prev.map(t => t.id === updated.id ? updated : t))
    }
  }

  function openThread(agentId: string, taskId?: string) {
    setSelectedAgentId(agentId)
    if (taskId) {
      setSelectedTaskId(taskId)
      setChatScope('single')
      return
    }
    const mostRecentTaskForAgent = agentTasks[0]?.id || null
    if (mostRecentTaskForAgent) {
      setSelectedTaskId(mostRecentTaskForAgent)
    } else {
      setSelectedTaskId(null)
      setAutoBindNotice('No open cards assigned to this agent yet. Assign a card to start a task-linked chat.')
    }
    setChatScope('single')
  }

  function openUnassignedTaskChat(taskId: string) {
    if (!selectedAgentId) {
      const fallbackAgent = chatAgents[0]?.id
      if (fallbackAgent) setSelectedAgentId(fallbackAgent)
    }
    setSelectedTaskId(taskId)
    setChatScope('single')
    setAutoBindNotice('Task opened in chat. Pick the best agent and send guidance to start execution.')
  }

  async function sendMessage() {
    const text = composer.trim()
    if (!selectedAgentId || !text) return

    const resolvedTaskId = selectedTaskId || null
    if (!resolvedTaskId) {
      setAutoBindNotice('Select a task to start chatting with this agent.')
      return
    }

    const scopePrefix = chatScope === 'all'
      ? `Scope: all cards assigned to ${selectedAgent?.name}.\nCards: ${agentTasks.map(t => t.title).join('; ')}\n\n`
      : ''

    const r = await fetch('/api/agents/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: selectedAgentId,
        text: scopePrefix + text,
        role: 'user',
        taskId: resolvedTaskId,
      }),
    })
    const out = await r.json().catch(() => null)
    if (r.ok) {
      setThread(out?.thread || null)
      setMessages(out?.thread?.messages || [])
      setComposer('')
      const latest = Array.isArray(out?.thread?.messages)
        ? [...out.thread.messages].reverse().find((m: ThreadMessage) => m.role === 'agent')
        : null
      if (latest) {
        const text = String(latest.text || '')
        const hasStatus = /current status|status:/i.test(text)
        const hasNext = /next step|next:/i.test(text)
        if (!hasStatus || !hasNext) {
          setAutoBindNotice('Agent responded, but confirmation format was incomplete. Ask for: what happened, what changed, next step.')
        }
      }
    } else {
      setAutoBindNotice(`Send failed${out?.error ? `: ${out.error}` : ''}`)
    }
  }

  async function claimSelectedTask() {
    if (!selectedTask || !selectedAgentId) return
    const executionAgentId = selectedAgent?.executionAgentId || selectedAgentId
    const r = await fetch(`/api/tasks/${selectedTask.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productAgentId: selectedAgentId, executionAgentId, actor: 'ClawPilot' }),
    })
    const out = await r.json()
    if (r.ok && out?.task) {
      setTasks(prev => prev.map(t => t.id === out.task.id ? out.task : t))
      setAutoBindNotice(`Task claimed: ${out.task.title || selectedTask.title}`)
    } else {
      setAutoBindNotice(`Claim failed${out?.error ? `: ${out.error}` : ''}`)
    }
  }

  async function runDocsAgent() {
    setDocsBootstrapMsg('Running docs agent...')
    try {
      const r = await fetch('/api/agents/docs-bootstrap', { method: 'POST' })
      const out = await r.json()
      if (!r.ok) throw new Error(out?.error || 'Docs bootstrap failed')
      setDocsBootstrapMsg('Docs agent completed: daily + business docs ensured')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setDocsBootstrapMsg(`Docs agent error: ${message}`)
    }
  }

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

  return (
    <Box p={{ xs: 2, md: 3 }}>
      <Typography variant="h5" fontWeight={700} color="text.primary" mb={1}>Agents</Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        Pick a task, chat with the right agent, and move the work forward.
      </Typography>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} mb={2}>
        <Chip label={`Agents: ${agents.length}`} />
        <Chip label={`Open tasks: ${openTasks.length}`} />
        <Chip label={`Assigned: ${assignedCount}`} color="primary" />
        <Button variant="text" size="small" onClick={() => setShowTools((v) => !v)} sx={{ textTransform: 'none', alignSelf: { xs: 'flex-start', md: 'center' } }}>
          {showTools ? 'Hide tools' : 'Show tools'}
        </Button>
      </Stack>
      {showTools && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mb={2}>
          <Button variant="outlined" size="small" onClick={runDocsAgent}>Run Docs Agent</Button>
          <Button variant="outlined" size="small" onClick={proposeConsolidation} disabled={consolidating}>
            {consolidating ? <CircularProgress size={14} /> : 'Propose Consolidation'}
          </Button>
        </Stack>
      )}
      <Snackbar
        open={!!autoBindNotice}
        autoHideDuration={3200}
        onClose={() => setAutoBindNotice('')}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert severity="info" variant="filled" onClose={() => setAutoBindNotice('')} sx={{ width: '100%' }}>
          {autoBindNotice}
        </Alert>
      </Snackbar>
      {docsBootstrapMsg && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>{docsBootstrapMsg}</Typography>
      )}
      {consolidation && (
        <Card sx={{ p: 1.25, mb: 2, backgroundColor: '#0F1720', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', maxHeight: { xs: '55vh', md: '50vh' } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography variant="subtitle2">Consolidation proposal (manual)</Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip label="Review only" size="small" sx={{ backgroundColor: 'rgba(168,199,250,0.18)', color: '#A8C7FA', border: '1px solid rgba(168,199,250,0.35)' }} />
              <Button size="small" variant="text" onClick={resetReviewDecisions} sx={{ textTransform: 'none' }}>Reset staged decisions</Button>
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
      )}

      <Box display="grid" gridTemplateColumns={{ xs: '1fr', md: 'minmax(280px, 340px) 1fr' }} gap={2.25} mb={3}>
        <Stack spacing={1.25}>
          {chatAgents.map(a => (
            <ButtonBase key={a.id} onClick={() => openThread(a.id)} sx={{ width: '100%', borderRadius: 3, textAlign: 'left' }}>
              <Card sx={{ width: '100%', p: 1.5, backgroundColor: a.id === selectedAgentId ? 'rgba(168,199,250,0.14)' : a.id === 'clawpilot' ? 'rgba(207,198,234,0.10)' : '#1A1A23', border: a.id === selectedAgentId ? '1px solid rgba(168,199,250,0.45)' : a.id === 'clawpilot' ? '1px solid rgba(207,198,234,0.35)' : '1px solid rgba(255,255,255,0.08)' }}>
                <Typography fontWeight={700}>{a.name}</Typography>
                <Typography variant="caption" color="text.secondary">{a.owner} · {a.status}{a.kind === 'orchestrator' ? ' · orchestrator' : ''}</Typography>
                <Typography variant="body2" color="text.secondary" mt={0.5}>{a.summary}</Typography>
              </Card>
            </ButtonBase>
          ))}
        </Stack>

        <Card sx={{ p: 1.5, backgroundColor: '#15151D', border: '1px solid rgba(255,255,255,0.06)', minHeight: 320, display: 'flex', flexDirection: 'column' }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="subtitle1" fontWeight={700}>{selectedAgent?.name || 'Agent Thread'}</Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              {selectedTask && (
                <Button size="small" variant="outlined" onClick={claimSelectedTask} disabled={!canClaim}>
                  Claim task
                </Button>
              )}
            </Stack>
          </Stack>
          <Typography variant="caption" color="text.secondary" mb={0.5}>
            {selectedTask ? `Task: ${selectedTask.title}` : 'Choose a task to start the conversation.'}
          </Typography>
          <Typography variant="caption" color="text.secondary" mb={1.25}>
            {selectedAgent?.name ? `Agent: ${selectedAgent.name}` : 'Agent: not selected'}
          </Typography>
          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mb: 1.25 }} />
          {selectedTask && (
            <Box sx={{ mb: 1.25, p: 1, borderRadius: 2, backgroundColor: 'rgba(168,199,250,0.08)', border: '1px solid rgba(168,199,250,0.2)' }}>
              <Typography variant="caption" color="text.secondary" display="block">Current task context</Typography>
              <Typography variant="body2" color="text.primary" fontWeight={600}>{selectedTask.title}</Typography>
              <Typography variant="caption" color="text.secondary" display="block">Status: {selectedTask.status} • Priority: {selectedTask.priority}</Typography>
              <Typography variant="caption" color="text.secondary" display="block">Assigned product agent: {selectedTask.assignedAgent || 'Unassigned'}</Typography>
              {selectedTaskTruth && (
                <Typography variant="caption" color="text.secondary" display="block">[{selectedTaskTruth.stateLabel}] — {selectedTaskTruth.reason}</Typography>
              )}
              {selectedTaskNext && (
                <Typography variant="caption" color="text.secondary" display="block">👉 Next: {selectedTaskNext}</Typography>
              )}
              {selectedTask.workItem?.lastConcreteAction && (
                <Typography variant="caption" color="text.secondary" display="block">Last action: {selectedTask.workItem.lastConcreteAction}</Typography>
              )}
              {selectedTask.workItem?.waitingOn && (
                <Typography variant="caption" color="text.secondary" display="block">Waiting on: {selectedTask.workItem.waitingOn}</Typography>
              )}
            </Box>
          )}
          {process.env.NODE_ENV === 'development' && selectedTask && (
            <Box sx={{ mb: 1.5, p: 1, borderRadius: 2, border: '1px dashed rgba(255,255,255,0.12)' }}>
              <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
                Suggestions test (dev only): suggestion → task is policy-blocked (default-deny). Use manual task creation (`_createSource=manual-ui`) when needed.
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Tooltip title="Blocked by task-creation policy during containment. Manual creation paths remain available.">
                  <span>
                    <Button size="small" variant="outlined" disabled>
                      Create task (policy blocked)
                    </Button>
                  </span>
                </Tooltip>
                <Button size="small" variant="outlined" onClick={async () => {
                  await fetch('/api/tasks', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      id: selectedTask.id,
                      _checklistAdd: { id: Date.now().toString(), text: 'Suggestion: add checklist item', done: false },
                      _actor: 'ClawPilot',
                    }),
                  })
                  await refreshTasks()
                }}>Add checklist item</Button>
                <Button size="small" variant="outlined" onClick={async () => {
                  await fetch('/api/tasks', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: selectedTask.id, _comment: 'Suggestion: add comment', _actor: 'ClawPilot' }),
                  })
                  await refreshTasks()
                }}>Add comment</Button>
              </Stack>
            </Box>
          )}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mb={1} alignItems={{ sm: 'center' }}>
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel>Conversation target</InputLabel>
              <Select
                label="Conversation target"
                value={chatScope}
                onChange={(e) => setChatScope(e.target.value as 'single' | 'all')}
              >
                <MenuItem value="single">Selected task</MenuItem>
                <MenuItem value="all">All assigned tasks (summary mode)</MenuItem>
              </Select>
            </FormControl>
            {chatScope === 'single' && (
              <Stack spacing={0.5} sx={{ minWidth: 260 }}>
                <FormControl size="small">
                  <InputLabel>Card</InputLabel>
                  <Select
                    label="Card"
                    value={selectedTaskId || ''}
                    onChange={(e) => setSelectedTaskId(String(e.target.value))}
                  >
                    {chatTaskOptions.map(t => {
                      const liveState = deriveLiveState(t)
                      const staleLabel = liveState.staleAgain ? ' • Stale again' : ''
                      const unassignedLabel = !t.assignedAgent ? ' • Unassigned' : ''
                      return (
                        <MenuItem key={t.id} value={t.id}>{`${t.title}${staleLabel}${unassignedLabel}`}</MenuItem>
                      )
                    })}
                  </Select>
                </FormControl>
                {hiddenChatTaskCount > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    Showing top {chatTaskOptions.length} relevant cards ({hiddenChatTaskCount} additional recent cards hidden to reduce picker noise).
                  </Typography>
                )}
              </Stack>
            )}
          </Stack>

          <Stack spacing={1} sx={{ flex: 1, minHeight: 180, maxHeight: { xs: 250, md: 340 }, overflowY: 'auto', pr: 0.5 }}>
            {messages.length === 0 ? (
              <Typography variant="body2" color="text.disabled">No messages yet. Start the thread.</Typography>
            ) : messages.map(m => (
              <Box key={m.id} sx={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
                <Box sx={{ px: 1.2, py: 0.9, borderRadius: 2, backgroundColor: m.role === 'user' ? 'rgba(168,199,250,0.22)' : 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <Typography variant="body2" color="text.primary" sx={{ whiteSpace: 'pre-line', lineHeight: 1.45 }}>{m.text}</Typography>
                </Box>
                <Typography variant="caption" color="text.disabled" sx={{ px: 0.5 }}>{new Date(m.createdAt).toLocaleString()}</Typography>
              </Box>
            ))}
          </Stack>

          <Stack direction="row" spacing={1} mt={1.25}>
            <TextField
              size="small"
              placeholder={selectedAgent ? `Ask ${selectedAgent.name} anything about this task` : 'Select an agent'}
              value={composer}
              onChange={e => setComposer(e.target.value)}
              fullWidth
              multiline
              minRows={1}
              maxRows={3}
            />
            <Button variant="contained" onClick={sendMessage} disabled={!selectedAgentId || !selectedTaskId || !composer.trim()}>
              Send to task
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" mt={0.75}>
            {selectedTaskId ? `Your message is linked to task ${selectedTaskId}.` : 'Pick a task to enable chat.'}
          </Typography>
        </Card>
      </Box>

      <Typography variant="subtitle2" color="text.primary" mb={1}>Assign open tasks</Typography>
      <Stack spacing={1}>
        {openTasks.slice(0, 20).map(t => {
          const productAssigned = productAgents.find(a => a.id === t.assignedAgent) || null
          const liveState = deriveLiveState(t)
          const boundAgentId = productAssigned?.id || ''
          const boundAgentName = productAssigned?.name || ''
          const canChat = !!productAssigned?.executionAgentId
          const eligibility = getAutoPickupEligibility(t)
          const executionStatus = t.execution?.executionStatus || ''
          const isRunning = executionStatus === 'running'
          const isQueued = !isRunning && eligibility.eligible
          const isAssigned = !!productAssigned
          return (
            <Card key={t.id} sx={{ p: 1.2, backgroundColor: '#15151D', border: '1px solid rgba(255,255,255,0.06)' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={600} noWrap>{t.title}</Typography>
                  <Typography variant="caption" color="text.secondary">{t.category} · {t.status}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Owner: {liveState.owner}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Last activity: {formatLiveActivityAge(liveState.lastActivityAt)}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Source: {liveState.activitySource}</Typography>
                  <Stack direction="row" spacing={0.75} mt={0.5} flexWrap="wrap">
                    {isAssigned && <Chip size="small" label="assigned" />}
                    {isQueued && <Chip size="small" color="info" label="queued" />}
                    {isRunning && <Chip size="small" color="success" label="running" />}
                    {liveState.staleAgain && <Chip size="small" label="Stale again" sx={{ backgroundColor: 'rgba(255,167,38,0.2)', color: '#FFA726' }} />}
                  </Stack>
                </Box>
                {boundAgentId && boundAgentName && canChat && (
                  <Button size="small" variant="text" onClick={() => openThread(boundAgentId, t.id)} sx={{ whiteSpace: 'nowrap' }}>
                    Open chat
                  </Button>
                )}
                {!boundAgentId && liveState.staleAgain && (
                  <Button size="small" variant="text" onClick={() => openUnassignedTaskChat(t.id)} sx={{ whiteSpace: 'nowrap' }}>
                    Open chat (pick agent)
                  </Button>
                )}
                <FormControl size="small" sx={{ minWidth: 220 }}>
                  <InputLabel>Agent</InputLabel>
                  <Select
                    label="Agent"
                    value={productAssigned?.id || ''}
                    onChange={(e) => assign(t.id, String(e.target.value))}
                  >
                    {productAgents.map(a => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                  </Select>
                </FormControl>
              </Stack>
            </Card>
          )
        })}
      </Stack>
    </Box>
  )
}
