'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import CheckRounded from '@mui/icons-material/CheckRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import DescriptionRounded from '@mui/icons-material/DescriptionRounded'
import ForumRounded from '@mui/icons-material/ForumRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import LoginRounded from '@mui/icons-material/LoginRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SendRounded from '@mui/icons-material/SendRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import type { Task } from '@/lib/types'
import { consumeAgentTaskOpen } from '@/lib/agents/navigation'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'

type Agent = {
  id: string
  name: string
  owner: string
  status: string
  summary: string
  executionAgentId?: string
  kind?: 'product' | 'orchestrator'
}

type Runtime = {
  provider: 'openai' | 'openai-codex' | 'openclaw' | 'none'
  ready: boolean
  status: 'ready' | 'not-configured'
  label: string
  model?: string
  auth?: {
    connected: boolean
    email?: string
    planType?: string
    expiresAt?: string
  }
}

type DeviceLogin = {
  loginId: string
  verificationUrl: string
  userCode: string
  expiresAt: string
}

type AuthPhase = 'waiting' | 'expired' | 'failed'
type InteractionMode = 'work' | 'discuss'

type ThreadMessage = {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  createdAt: string
  taskId?: string
}

function formatTimestamp(value: string | undefined, settings: UserDateTimeSettings) {
  return formatUserDateTime(value, settings, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function taskExecutionView(task: Task | null) {
  const execution = task?.execution
  const result = asRecord(execution?.lastResult)
  const document = asRecord(result.document)
  const dispatch = execution?.agentDispatch
  const executionStatus = String(execution?.executionStatus || '').trim().toLowerCase()
  const dispatchStatus = String(dispatch?.status || '').trim().toLowerCase()
  const active = dispatchStatus === 'queued' || dispatchStatus === 'running'
  const failed = dispatchStatus === 'failed'
  const status = failed
    ? 'failed'
    : active
      ? dispatchStatus
      : executionStatus || dispatchStatus || 'idle'
  const label = ({
    queued: 'Queued',
    running: 'Working',
    awaiting_input: 'Needs your input',
    blocked: 'Blocked',
    completed: 'Ready to review',
    triaged: 'Plan prepared',
    responded: 'Discussion updated',
    succeeded: 'Run recorded',
    failed: 'Run failed',
    idle: 'Ready',
  } as Record<string, string>)[status] || status.replaceAll('_', ' ')
  const color = status === 'failed' || status === 'blocked'
    ? 'error'
    : status === 'awaiting_input'
      ? 'warning'
      : status === 'completed' || status === 'succeeded'
        ? 'success'
        : active
          ? 'info'
          : 'default'

  return {
    active,
    failed,
    status,
    label,
    color: color as 'default' | 'error' | 'warning' | 'success' | 'info',
    summary: String(result.summary || '').trim(),
    changed: String(result.whatWasDone || '').trim(),
    nextAction: String(result.nextAction || task?.workItem?.nextAction || '').trim(),
    waitingOn: String(result.waitingOn || task?.workItem?.waitingOn || '').trim(),
    blocker: String(result.blockedReason || task?.workItem?.blocker || '').trim(),
    documentTitle: String(document.title || '').trim(),
    documentUrl: String(document.url || '').trim(),
    error: String(dispatch?.error || '').trim(),
  }
}

function payloadMessage(payload: Record<string, unknown>, fallback: string) {
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
  const error = asRecord(payload.error)
  if (typeof error.message === 'string' && error.message.trim()) return error.message
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  return fallback
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through for browsers that block clipboard access outside secure contexts.
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
  } catch {
    return false
  }
}

export default function AgentsSection() {
  const dateTimeSettings = useUserDateTime()
  const shortLandscape = useMediaQuery('(orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)')
  const [agents, setAgents] = useState<Agent[]>([])
  const [runtime, setRuntime] = useState<Runtime | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [composer, setComposer] = useState('')
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('work')
  const [sending, setSending] = useState(false)
  const [sendingMode, setSendingMode] = useState<InteractionMode | null>(null)
  const [notice, setNotice] = useState('')
  const [authStarting, setAuthStarting] = useState(false)
  const [authDisconnecting, setAuthDisconnecting] = useState(false)
  const [deviceLogin, setDeviceLogin] = useState<DeviceLogin | null>(null)
  const [authPhase, setAuthPhase] = useState<AuthPhase>('waiting')
  const [authError, setAuthError] = useState('')
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)

  const loadWorkspace = useCallback(async () => {
    const [agentResponse, taskResponse] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/tasks'),
    ])
    const agentPayload = await agentResponse.json()
    const taskPayload = await taskResponse.json()
    const nextAgents = Array.isArray(agentPayload?.agents) ? agentPayload.agents : []
    setAgents(nextAgents)
    setRuntime(agentPayload?.runtime || null)
    const nextTasks = Array.isArray(taskPayload) ? taskPayload : []
    setTasks(nextTasks)
    const pendingOpen = consumeAgentTaskOpen()
    const pendingTask = pendingOpen
      ? nextTasks.find((task: Task) => task.id === pendingOpen.taskId && task.assignedAgent === pendingOpen.agentId)
      : null
    if (pendingTask && pendingOpen) {
      setSelectedAgentId(pendingOpen.agentId)
      setSelectedTaskId(pendingTask.id)
      return
    }
    const firstAssignedAgent = nextAgents.find((agent: Agent) => nextTasks.some((task: Task) => (
      task.assignedAgent === agent.id && task.status !== 'done' && !task.archived && !task.deletedAt
    )))
    setSelectedAgentId((current) => current || firstAssignedAgent?.id || nextAgents[0]?.id || '')
  }, [])

  useEffect(() => {
    loadWorkspace().catch(() => setNotice('Unable to load agent workspace.'))
  }, [loadWorkspace])

  useEffect(() => {
    if (!deviceLogin) return

    const activeLogin = deviceLogin
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const expiresAt = new Date(activeLogin.expiresAt).getTime()

    function expireLogin() {
      setAuthPhase('expired')
      setAuthError('This device code has expired. Start a new connection to continue.')
    }

    async function poll() {
      if (cancelled) return
      if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
        expireLogin()
        return
      }

      try {
        const response = await fetch('/api/agents/auth/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loginId: activeLogin.loginId }),
          signal: controller.signal,
        })
        const payload = asRecord(await response.json().catch(() => null))
        const auth = asRecord(payload.auth)
        const status = String(payload.status || payload.state || '').trim().toLowerCase()
        const completed = payload.completed === true
          || payload.connected === true
          || auth.connected === true
          || ['complete', 'completed', 'connected', 'success'].includes(status)
        const expired = payload.expired === true
          || response.status === 410
          || ['expired', 'code_expired'].includes(status)
        const failed = ['failed', 'error', 'denied', 'access_denied', 'cancelled', 'canceled'].includes(status)

        if (completed) {
          setDeviceLogin(null)
          setNotice('ChatGPT connected.')
          await loadWorkspace().catch(() => setNotice('ChatGPT connected, but the workspace could not be refreshed.'))
          return
        }
        if (expired) {
          expireLogin()
          return
        }
        if (!response.ok || failed) {
          throw new Error(payloadMessage(payload, 'ChatGPT authorization failed.'))
        }

        timer = setTimeout(poll, 3000)
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        setAuthPhase('failed')
        setAuthError(error instanceof Error ? error.message : 'ChatGPT authorization failed.')
      }
    }

    timer = setTimeout(poll, 3000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }, [deviceLogin, loadWorkspace])

  const openTasks = useMemo(
    () => tasks.filter((task) => task.status !== 'done' && !task.archived && !task.deletedAt),
    [tasks],
  )
  const assignedTasks = useMemo(
    () => openTasks.filter((task) => (
      task.assignedAgent === selectedAgentId
    )),
    [openTasks, selectedAgentId],
  )
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) || null
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null
  const selectedDispatchStatus = selectedTask?.execution?.agentDispatch?.status
  const executionView = taskExecutionView(selectedTask)
  const assignedCount = openTasks.filter((task) => Boolean(task.assignedAgent)).length

  useEffect(() => {
    if (!selectedAgentId) return
    const stillValid = assignedTasks.some((task) => task.id === selectedTaskId)
    if (!stillValid) setSelectedTaskId(assignedTasks[0]?.id || '')
  }, [assignedTasks, selectedAgentId, selectedTaskId])

  useEffect(() => {
    if (!selectedAgentId || !selectedTaskId) {
      setMessages([])
      return
    }
    const params = new URLSearchParams({ agentId: selectedAgentId, taskId: selectedTaskId })
    fetch(`/api/agents/threads?${params.toString()}`)
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload?.error || 'Unable to load task thread')
        setMessages(Array.isArray(payload?.messages) ? payload.messages : [])
      })
      .catch((error) => {
        setMessages([])
        setNotice(error instanceof Error ? error.message : 'Unable to load task thread.')
      })
  }, [selectedAgentId, selectedTaskId])

  useEffect(() => {
    if (selectedDispatchStatus !== 'queued' && selectedDispatchStatus !== 'running') return
    let active = true
    const refresh = async () => {
      try {
        await loadWorkspace()
        const params = new URLSearchParams({ agentId: selectedAgentId, taskId: selectedTaskId })
        const response = await fetch(`/api/agents/threads?${params.toString()}`)
        const payload = await response.json()
        if (active && response.ok) setMessages(Array.isArray(payload?.messages) ? payload.messages : [])
      } catch {
        // The next polling interval will retry while the dispatch remains active.
      }
    }
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [loadWorkspace, selectedAgentId, selectedDispatchStatus, selectedTaskId])

  useEffect(() => {
    function onOpenAgentTask(event: Event) {
      const detail = (event as CustomEvent<{ taskId?: string; agentId?: string }>).detail || {}
      const task = tasks.find((entry) => entry.id === detail.taskId)
      const agentId = detail.agentId || task?.assignedAgent || ''
      if (!task || !agentId) {
        setNotice('Assign this task to an agent before opening its thread.')
        return
      }
      setSelectedAgentId(agentId)
      setSelectedTaskId(task.id)
    }
    window.addEventListener('open-agent-task', onOpenAgentTask)
    return () => window.removeEventListener('open-agent-task', onOpenAgentTask)
  }, [tasks])

  async function assign(taskId: string, agentId: string) {
    const response = await fetch('/api/agents/assignments', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, agentId }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      setNotice(payload?.error || 'Assignment failed.')
      return
    }
    const updatedTask = payload?.task as Task | undefined
    setTasks((current) => current.map((task) => task.id === taskId
      ? updatedTask || { ...task, assignedAgent: agentId || undefined, updatedAt: new Date().toISOString() }
      : task))
    if (taskId === selectedTaskId && agentId !== selectedAgentId) setSelectedTaskId('')
    if (agentId) {
      setSelectedAgentId(agentId)
      setSelectedTaskId(taskId)
      setNotice('Task assigned. Agent run queued.')
    }
  }

  async function sendMessage(textOverride?: string, modeOverride?: InteractionMode) {
    const text = String(textOverride || composer).trim()
    const mode = modeOverride || interactionMode
    if (!selectedAgentId || !selectedTaskId || !text || !runtime?.ready) return
    if (mode === 'work' && executionView.active) {
      setNotice('This task already has an active agent run.')
      return
    }
    const optimisticMessageId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setMessages((current) => [
      ...current,
      {
        id: optimisticMessageId,
        role: 'user',
        text,
        createdAt: new Date().toISOString(),
        taskId: selectedTaskId,
      },
    ])
    if (!textOverride) setComposer('')
    setSending(true)
    setSendingMode(mode)
    try {
      const response = await fetch('/api/agents/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, taskId: selectedTaskId, text, mode }),
      })
      const payload = await response.json().catch(() => null)
      if (payload?.runtime) setRuntime(payload.runtime)
      if (!response.ok) throw new Error(payload?.error || 'Agent request failed')
      setMessages(Array.isArray(payload?.thread?.messages) ? payload.thread.messages : [])
      await loadWorkspace()
      if (payload?.queued) setNotice('Agent work queued. Progress will update here automatically.')
    } catch (error) {
      try {
        const params = new URLSearchParams({ agentId: selectedAgentId, taskId: selectedTaskId })
        const response = await fetch(`/api/agents/threads?${params.toString()}`)
        const payload = await response.json()
        if (response.ok) setMessages(Array.isArray(payload?.messages) ? payload.messages : [])
      } catch {
        setMessages((current) => current.filter((message) => message.id !== optimisticMessageId))
      }
      if (!textOverride) setComposer((current) => current || text)
      setNotice(error instanceof Error ? error.message : 'Agent request failed.')
    } finally {
      setSending(false)
      setSendingMode(null)
    }
  }

  async function runNextAction() {
    const nextAction = executionView.nextAction || 'Continue the task from the current description and complete the next concrete step.'
    await sendMessage(`Continue work. Next action: ${nextAction}`, 'work')
  }

  function closeAuthDialog() {
    setDeviceLogin(null)
    setAuthPhase('waiting')
    setAuthError('')
    setPopupBlocked(false)
    setCodeCopied(false)
  }

  async function startChatGPTAuth() {
    if (authStarting) return
    setAuthStarting(true)
    setAuthPhase('waiting')
    setAuthError('')
    setPopupBlocked(false)
    setCodeCopied(false)

    try {
      const response = await fetch('/api/agents/auth', { method: 'POST' })
      const payload = asRecord(await response.json().catch(() => null))
      if (!response.ok) throw new Error(payloadMessage(payload, 'Unable to start ChatGPT authorization.'))

      const loginId = typeof payload.loginId === 'string' ? payload.loginId : ''
      const verificationUrl = typeof payload.verificationUrl === 'string' ? payload.verificationUrl : ''
      const userCode = typeof payload.userCode === 'string' ? payload.userCode : ''
      const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt : ''
      if (!loginId || !verificationUrl || !userCode || !expiresAt) {
        throw new Error('ChatGPT authorization returned an incomplete device login.')
      }

      setDeviceLogin({ loginId, verificationUrl, userCode, expiresAt })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to start ChatGPT authorization.')
    } finally {
      setAuthStarting(false)
    }
  }

  async function copyAndOpenVerificationUrl() {
    if (!deviceLogin) return
    const copyPromise = copyText(deviceLogin.userCode)
    const popup = window.open(deviceLogin.verificationUrl, '_blank')
    if (!popup) {
      setPopupBlocked(true)
      setAuthError('The verification page could not be opened. Allow popups and try again.')
    } else {
      popup.opener = null
      setPopupBlocked(false)
    }

    const copied = await copyPromise
    setCodeCopied(copied)
    setNotice(copied ? 'Device code copied.' : 'Unable to copy the device code.')
  }

  async function copyDeviceCode() {
    if (!deviceLogin) return
    const copied = await copyText(deviceLogin.userCode)
    setCodeCopied(copied)
    setNotice(copied ? 'Device code copied.' : 'Unable to copy the device code.')
  }

  async function disconnectChatGPT() {
    if (authDisconnecting) return
    setAuthDisconnecting(true)
    try {
      const response = await fetch('/api/agents/auth', { method: 'DELETE' })
      const payload = asRecord(await response.json().catch(() => null))
      if (!response.ok) throw new Error(payloadMessage(payload, 'Unable to disconnect ChatGPT.'))
      setNotice('ChatGPT disconnected.')
      await loadWorkspace()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to disconnect ChatGPT.')
    } finally {
      setAuthDisconnecting(false)
    }
  }

  const codexAuth = runtime?.provider === 'openai-codex' ? runtime.auth : undefined
  const codexConnected = Boolean(codexAuth?.connected)
  const codexAccountDetails = [
    codexAuth?.email,
    codexAuth?.planType,
    codexAuth?.expiresAt ? `Expires ${formatTimestamp(codexAuth.expiresAt, dateTimeSettings)}` : '',
    codexConnected ? 'Task discussion and documents; repository runner not connected' : '',
  ].filter(Boolean).join(' | ')

  return (
    <Box p={shortLandscape ? 1 : { xs: 2, md: 3 }}>
      <Stack direction="row" justifyContent="space-between" spacing={shortLandscape ? 0.75 : 1.5} mb={shortLandscape ? 0.75 : 2} alignItems="center">
        <Box>
          <Typography variant="h5" fontWeight={700} color="text.primary" sx={shortLandscape ? { fontSize: '1rem' } : undefined}>Agents</Typography>
          {!shortLandscape && <Typography variant="body2" color="text.secondary">Task ownership and execution threads</Typography>}
        </Box>
        <Stack direction="row" spacing={shortLandscape ? 0.5 : 1} alignItems="center" flexWrap={shortLandscape ? 'nowrap' : 'wrap'} sx={{ overflowX: 'auto', minWidth: 0 }}>
          <Chip size="small" label={`${agents.length} agents`} />
          <Chip size="small" label={`${assignedCount}/${openTasks.length} assigned`} />
          <Tooltip title={codexConnected ? codexAccountDetails || 'ChatGPT connected' : ''}>
            <Chip
              size="small"
              color={runtime?.ready ? 'success' : 'default'}
              label={runtime?.label || 'Checking provider'}
              sx={{ maxWidth: { xs: 190, sm: 280 }, '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
            />
          </Tooltip>
          {codexConnected && (
            <Tooltip title={`Disconnect ChatGPT${codexAuth?.email ? ` for ${codexAuth.email}` : ''}`}>
              <span>
                <IconButton
                  size="small"
                  aria-label="Disconnect ChatGPT"
                  onClick={disconnectChatGPT}
                  disabled={authDisconnecting}
                  sx={{ width: 28, height: 28, color: 'text.secondary' }}
                >
                  {authDisconnecting ? <CircularProgress size={16} /> : <LinkOffRounded sx={{ fontSize: 17 }} />}
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
      </Stack>

      {runtime && !runtime.ready && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 1, '& .MuiAlert-message': { width: '100%', minWidth: 0 } }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between" spacing={1} minWidth={0}>
            <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {runtime.label}. Assignments and task history remain available; agent messages are disabled.
            </Typography>
            {runtime.provider === 'openai-codex' && !codexConnected && (
              <Button
                size="small"
                variant="outlined"
                startIcon={authStarting ? <CircularProgress size={14} /> : <LoginRounded />}
                onClick={startChatGPTAuth}
                disabled={authStarting}
                sx={{ flexShrink: 0, textTransform: 'none', whiteSpace: 'nowrap' }}
              >
                {authStarting ? 'Connecting' : 'Connect ChatGPT'}
              </Button>
            )}
          </Stack>
        </Alert>
      )}

      <Box display="grid" gridTemplateColumns={{ xs: '1fr', md: '280px minmax(0, 1fr)' }} gap={shortLandscape ? 1 : 2}>
        <Stack
          direction={shortLandscape ? 'row' : 'column'}
          spacing={1}
          sx={shortLandscape ? { overflowX: 'auto', WebkitOverflowScrolling: 'touch', pb: 0.25 } : undefined}
        >
          {agents.map((agent) => {
            const active = agent.id === selectedAgentId
            const taskCount = openTasks.filter((task) => task.assignedAgent === agent.id).length
            return (
              <ButtonBase
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                sx={{ width: shortLandscape ? 180 : '100%', minWidth: shortLandscape ? 180 : 0, textAlign: 'left', borderRadius: 1, flexShrink: 0 }}
              >
                <Card sx={{ width: '100%', p: 1.25, borderRadius: 1, backgroundColor: active ? 'rgba(168,199,250,0.12)' : '#1A1A23', border: active ? '1px solid rgba(168,199,250,0.5)' : '1px solid rgba(255,255,255,0.08)' }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Typography variant="subtitle2" fontWeight={700}>{agent.name}</Typography>
                    <Chip size="small" label={taskCount} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{agent.owner} | {agent.status}</Typography>
                  {!shortLandscape && <Typography variant="body2" color="text.secondary" mt={0.5}>{agent.summary}</Typography>}
                </Card>
              </ButtonBase>
            )
          })}
        </Stack>

        <Card data-testid="agents-thread" sx={{ minHeight: shortLandscape ? 200 : 520, p: shortLandscape ? 1 : 1.5, borderRadius: 1, backgroundColor: '#15151D', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }}>
          <Stack direction={shortLandscape ? 'row' : { xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1} mb={shortLandscape ? 0.75 : 1.25}>
            <Box minWidth={0}>
              <Typography variant="subtitle1" fontWeight={700}>{selectedAgent?.name || 'Agent thread'}</Typography>
              <Typography variant="caption" color="text.secondary">{selectedTask?.title || 'No assigned task selected'}</Typography>
            </Box>
            <FormControl size="small" sx={{ minWidth: shortLandscape ? 280 : { xs: '100%', sm: 260 } }}>
              <InputLabel>Task</InputLabel>
              <Select label="Task" value={selectedTaskId} onChange={(event) => setSelectedTaskId(String(event.target.value))}>
                {assignedTasks.map((task) => <MenuItem key={task.id} value={task.id}>{task.title}</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>

          {selectedTask && (
            <Box data-testid="agent-task-status" sx={{ px: shortLandscape ? 0.75 : 1.25, py: shortLandscape ? 0.5 : 1, mb: shortLandscape ? 0.75 : 1.25, maxHeight: shortLandscape ? 112 : 'none', overflow: shortLandscape ? 'auto' : 'visible', borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.04)' }}>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" alignItems="center" mb={0.75}>
                <Chip size="small" label={selectedTask.status} />
                <Chip size="small" label={selectedTask.priority} />
                <Chip size="small" color={executionView.color} label={executionView.label} />
                {selectedTask.dueDate && <Chip size="small" label={`Due ${selectedTask.dueDate}`} />}
              </Stack>
              {executionView.active && <LinearProgress color="info" sx={{ height: 3, borderRadius: 1, mb: 0.75 }} />}
              {selectedTask.desc && !shortLandscape && <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{selectedTask.desc}</Typography>}
              {executionView.summary && !shortLandscape && (
                <Typography variant="body2" color="text.primary" display="block" mt={0.75}>{executionView.summary}</Typography>
              )}
              {executionView.changed && !shortLandscape && (
                <Typography variant="caption" color="text.secondary" display="block" mt={0.4} sx={{ overflowWrap: 'anywhere' }}>
                  <Box component="span" color="text.disabled">Changed:</Box> {executionView.changed}
                </Typography>
              )}
              <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'minmax(0, 1fr) auto' }} gap={0.75} alignItems="end" mt={0.75}>
                <Box minWidth={0}>
                  {executionView.nextAction && (
                    <Typography variant="caption" color="text.primary" display="block" sx={{ overflowWrap: 'anywhere' }}>
                      <Box component="span" color="text.disabled">Next:</Box> {executionView.nextAction}
                    </Typography>
                  )}
                  {(executionView.blocker || executionView.waitingOn) && (
                    <Typography variant="caption" color={executionView.blocker ? 'error.light' : 'warning.light'} display="block" mt={0.4} sx={{ overflowWrap: 'anywhere' }}>
                      <Box component="span" color="text.disabled">Waiting on:</Box> {executionView.blocker || executionView.waitingOn}
                    </Typography>
                  )}
                  {executionView.error && (
                    <Typography variant="caption" color="error.light" display="block" mt={0.4} sx={{ overflowWrap: 'anywhere' }}>
                      {executionView.error}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" display="block" mt={0.4}>
                    Checklist: {(selectedTask.checklist || []).filter((item) => item.done).length}/{(selectedTask.checklist || []).length}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.75} flexWrap="wrap" justifyContent={{ xs: 'flex-start', sm: 'flex-end' }}>
                  {executionView.documentUrl && (
                    <Button
                      size="small"
                      href={executionView.documentUrl}
                      startIcon={<DescriptionRounded />}
                      sx={{ textTransform: 'none' }}
                    >
                      {executionView.documentTitle || 'Working document'}
                    </Button>
                  )}
                  {!executionView.active && runtime?.ready && executionView.nextAction && (
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={executionView.failed ? <ReplayRounded /> : <PlayArrowRounded />}
                      onClick={runNextAction}
                      disabled={sending}
                      sx={{ textTransform: 'none' }}
                    >
                      {executionView.failed ? 'Retry work' : 'Run next step'}
                    </Button>
                  )}
                </Stack>
              </Box>
            </Box>
          )}

          <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: shortLandscape ? 0.75 : 1.25 }} />
          <Stack spacing={1} sx={{ flex: 1, minHeight: shortLandscape ? 40 : 220, maxHeight: shortLandscape ? 72 : 380, overflowY: 'auto', pr: 0.5 }}>
            {!selectedTaskId ? (
              <Typography variant="body2" color="text.disabled">No open tasks assigned to this agent.</Typography>
            ) : messages.length === 0 ? (
              <Typography variant="body2" color="text.disabled">No task thread yet.</Typography>
            ) : messages.map((message) => (
              <Box key={message.id} sx={{ alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
                <Box sx={{ px: 1.2, py: 0.9, borderRadius: 1, backgroundColor: message.role === 'user' ? 'rgba(168,199,250,0.2)' : message.role === 'system' ? 'rgba(239,83,80,0.12)' : 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <Typography variant="body2" color="text.primary" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{message.text}</Typography>
                </Box>
                <Typography variant="caption" color="text.disabled" sx={{ px: 0.5 }}>
                  {message.role === 'user' ? 'You' : message.role === 'agent' ? selectedAgent?.name || 'Agent' : 'System'} | {formatTimestamp(message.createdAt, dateTimeSettings)}
                </Typography>
              </Box>
            ))}
            {sendingMode && (
              <Stack direction="row" spacing={0.75} alignItems="center" color="text.secondary" px={0.5}>
                <CircularProgress size={14} color="inherit" />
                <Typography variant="caption">
                  {sendingMode === 'work' ? 'Queueing auditable work...' : `${selectedAgent?.name || 'Agent'} is responding...`}
                </Typography>
              </Stack>
            )}
          </Stack>

          <Box mt={shortLandscape ? 0.75 : 1.25}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} mb={0.75}>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={interactionMode}
                onChange={(_, value: InteractionMode | null) => { if (value) setInteractionMode(value) }}
                aria-label="Agent interaction mode"
                sx={{ '& .MuiToggleButton-root': { textTransform: 'none', minHeight: 32, px: 1.25, gap: 0.5 } }}
              >
                <ToggleButton value="work" aria-label="Work mode" disabled={sending}>
                  <Tooltip title="Queue auditable task work and update its evidence">
                    <Box component="span" display="inline-flex" alignItems="center" gap={0.5}><PlayArrowRounded sx={{ fontSize: 17 }} />Work</Box>
                  </Tooltip>
                </ToggleButton>
                <ToggleButton value="discuss" aria-label="Discuss mode" disabled={sending}>
                  <Tooltip title="Discuss this task without changing its work evidence">
                    <Box component="span" display="inline-flex" alignItems="center" gap={0.5}><ForumRounded sx={{ fontSize: 17 }} />Discuss</Box>
                  </Tooltip>
                </ToggleButton>
              </ToggleButtonGroup>
              {executionView.active && <Typography variant="caption" color="info.light">Agent working</Typography>}
            </Stack>
            <Stack direction="row" spacing={1} alignItems="flex-end">
              <TextField
                size="small"
                placeholder={!selectedTask
                  ? 'Assign a task to start a thread'
                  : interactionMode === 'work'
                    ? `Give ${selectedAgent?.name || 'the agent'} a concrete work instruction`
                    : `Discuss this task with ${selectedAgent?.name || 'the agent'}`}
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void sendMessage()
                  }
                }}
                fullWidth
                multiline
                minRows={1}
                maxRows={4}
                disabled={!selectedTaskId || !runtime?.ready || sending || (interactionMode === 'work' && executionView.active)}
              />
              <Tooltip title={interactionMode === 'work' ? 'Queue agent work' : 'Send discussion message'}>
                <span>
                  <IconButton
                    color="primary"
                    aria-label={interactionMode === 'work' ? 'Queue agent work' : 'Send discussion message'}
                    onClick={() => { void sendMessage() }}
                    disabled={!selectedTaskId || !runtime?.ready || !composer.trim() || sending || (interactionMode === 'work' && executionView.active)}
                    sx={{ width: 40, height: 40 }}
                  >
                    {sending ? <CircularProgress size={20} /> : interactionMode === 'work' ? <PlayArrowRounded /> : <SendRounded />}
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        </Card>
      </Box>

      <Typography variant="subtitle2" color="text.primary" mt={3} mb={1}>Open task ownership</Typography>
      <Stack spacing={0.75}>
        {openTasks.map((task) => (
          <Box key={task.id} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 220px' }, gap: 1, alignItems: 'center', px: 1.25, py: 1, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <ButtonBase
              onClick={() => {
                if (!task.assignedAgent) return
                setSelectedAgentId(task.assignedAgent)
                setSelectedTaskId(task.id)
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
              disabled={!task.assignedAgent}
              aria-label={task.assignedAgent ? `Open ${task.title} agent thread` : undefined}
              sx={{ minWidth: 0, justifyContent: 'flex-start', textAlign: 'left', borderRadius: 1, px: 0.25, py: 0.25 }}
            >
              <Box minWidth={0}>
                <Typography variant="body2" fontWeight={600} noWrap>{task.title}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {task.status} | {task.priority}{task.assignedAgent ? ` | ${taskExecutionView(task).label}` : ''}
                </Typography>
              </Box>
            </ButtonBase>
            <FormControl size="small">
              <InputLabel>Assigned agent</InputLabel>
              <Select
                label="Assigned agent"
                value={task.assignedAgent || ''}
                onChange={(event) => assign(task.id, String(event.target.value))}
              >
                <MenuItem value="">Unassigned</MenuItem>
                {agents.map((agent) => <MenuItem key={agent.id} value={agent.id}>{agent.name}</MenuItem>)}
              </Select>
            </FormControl>
          </Box>
        ))}
      </Stack>

      <Dialog
        open={Boolean(deviceLogin)}
        onClose={closeAuthDialog}
        maxWidth="xs"
        fullWidth
        fullScreen={shortLandscape}
        PaperProps={{ sx: { mx: shortLandscape ? 0 : 2, borderRadius: shortLandscape ? 0 : 1, backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)' } }}
      >
        <DialogTitle sx={{ pb: 1, color: 'text.primary', fontWeight: 700 }}>Connect ChatGPT</DialogTitle>
        <DialogContent>
          {popupBlocked && (
            <Alert severity="warning" sx={{ mb: 1.5, borderRadius: 1 }}>
              The verification page was blocked. Allow popups, then try again below.
            </Alert>
          )}

          <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>Device code</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, px: 1.25, py: 1, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <Typography
              component="code"
              sx={{ flex: 1, minWidth: 0, color: 'text.primary', fontFamily: 'monospace', fontSize: '1.35rem', fontWeight: 700, lineHeight: 1.3, overflowWrap: 'anywhere' }}
            >
              {deviceLogin?.userCode}
            </Typography>
            <Tooltip title={codeCopied ? 'Copied' : 'Copy device code'}>
              <IconButton size="small" aria-label="Copy device code" onClick={copyDeviceCode} sx={{ flexShrink: 0 }}>
                {codeCopied ? <CheckRounded fontSize="small" color="success" /> : <ContentCopyRounded fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Box>

          {authPhase === 'waiting' ? (
            <Stack direction="row" alignItems="center" spacing={1} mt={1.5} minWidth={0}>
              <CircularProgress size={15} />
              <Box minWidth={0}>
                <Typography variant="body2" color="text.secondary">Waiting for authorization</Typography>
                <Typography variant="caption" color="text.disabled" sx={{ overflowWrap: 'anywhere' }}>
                  Expires {formatTimestamp(deviceLogin?.expiresAt, dateTimeSettings)}
                </Typography>
              </Box>
            </Stack>
          ) : (
            <Alert severity="error" sx={{ mt: 1.5, borderRadius: 1, '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
              {authError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap' }}>
          <Button onClick={closeAuthDialog} sx={{ color: 'text.secondary', textTransform: 'none' }}>Close</Button>
          {authPhase === 'waiting' ? (
            <Button startIcon={<OpenInNewRounded />} onClick={copyAndOpenVerificationUrl} variant="contained" sx={{ textTransform: 'none' }}>
              Copy code and open ChatGPT
            </Button>
          ) : (
            <Button startIcon={<RefreshRounded />} onClick={() => { closeAuthDialog(); void startChatGPTAuth() }} variant="contained" sx={{ textTransform: 'none' }}>
              Try again
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Snackbar open={Boolean(notice)} autoHideDuration={4000} onClose={() => setNotice('')} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
        <Alert severity="info" variant="filled" onClose={() => setNotice('')}>{notice}</Alert>
      </Snackbar>
    </Box>
  )
}
