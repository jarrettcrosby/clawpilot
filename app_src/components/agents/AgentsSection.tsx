'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import SendRounded from '@mui/icons-material/SendRounded'
import type { Task } from '@/lib/types'

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
  provider: 'openai' | 'openclaw' | 'none'
  ready: boolean
  status: 'ready' | 'not-configured'
  label: string
  model?: string
}

type ThreadMessage = {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  createdAt: string
  taskId?: string
}

function formatTimestamp(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

export default function AgentsSection() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [runtime, setRuntime] = useState<Runtime | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')

  async function loadWorkspace() {
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
    const firstAssignedAgent = nextAgents.find((agent: Agent) => nextTasks.some((task: Task) => (
      task.assignedAgent === agent.id && task.status !== 'done' && !task.archived && !task.deletedAt
    )))
    setSelectedAgentId((current) => current || firstAssignedAgent?.id || nextAgents[0]?.id || '')
  }

  useEffect(() => {
    loadWorkspace().catch(() => setNotice('Unable to load agent workspace.'))
  }, [])

  const openTasks = useMemo(
    () => tasks.filter((task) => task.status !== 'done' && !task.archived && !task.deletedAt),
    [tasks],
  )
  const assignedTasks = useMemo(
    () => openTasks.filter((task) => task.assignedAgent === selectedAgentId),
    [openTasks, selectedAgentId],
  )
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) || null
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null
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
    setTasks((current) => current.map((task) => (
      task.id === taskId ? { ...task, assignedAgent: agentId || undefined, updatedAt: new Date().toISOString() } : task
    )))
    if (taskId === selectedTaskId && agentId !== selectedAgentId) setSelectedTaskId('')
  }

  async function sendMessage() {
    const text = composer.trim()
    if (!selectedAgentId || !selectedTaskId || !text || !runtime?.ready) return
    setSending(true)
    try {
      const response = await fetch('/api/agents/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, taskId: selectedTaskId, text }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || 'Agent request failed')
      setMessages(Array.isArray(payload?.thread?.messages) ? payload.thread.messages : [])
      setComposer('')
      if (payload?.canonicalWorkItem) {
        setTasks((current) => current.map((task) => (
          task.id === selectedTaskId
            ? { ...task, workItem: payload.canonicalWorkItem, updatedAt: new Date().toISOString() }
            : task
        )))
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent request failed.')
    } finally {
      setSending(false)
    }
  }

  return (
    <Box p={{ xs: 2, md: 3 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5} mb={2}>
        <Box>
          <Typography variant="h5" fontWeight={700} color="text.primary">Agents</Typography>
          <Typography variant="body2" color="text.secondary">Task ownership and execution threads</Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Chip size="small" label={`${agents.length} agents`} />
          <Chip size="small" label={`${assignedCount}/${openTasks.length} assigned`} />
          <Chip
            size="small"
            color={runtime?.ready ? 'success' : 'default'}
            label={runtime?.label || 'Checking provider'}
          />
        </Stack>
      </Stack>

      {runtime && !runtime.ready && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 1 }}>
          {runtime.label}. Assignments and task history remain available; agent messages are disabled.
        </Alert>
      )}

      <Box display="grid" gridTemplateColumns={{ xs: '1fr', md: '280px minmax(0, 1fr)' }} gap={2}>
        <Stack spacing={1}>
          {agents.map((agent) => {
            const active = agent.id === selectedAgentId
            const taskCount = openTasks.filter((task) => task.assignedAgent === agent.id).length
            return (
              <ButtonBase
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                sx={{ width: '100%', textAlign: 'left', borderRadius: 1 }}
              >
                <Card sx={{ width: '100%', p: 1.25, borderRadius: 1, backgroundColor: active ? 'rgba(168,199,250,0.12)' : '#1A1A23', border: active ? '1px solid rgba(168,199,250,0.5)' : '1px solid rgba(255,255,255,0.08)' }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Typography variant="subtitle2" fontWeight={700}>{agent.name}</Typography>
                    <Chip size="small" label={taskCount} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{agent.owner} | {agent.status}</Typography>
                  <Typography variant="body2" color="text.secondary" mt={0.5}>{agent.summary}</Typography>
                </Card>
              </ButtonBase>
            )
          })}
        </Stack>

        <Card sx={{ minHeight: 520, p: 1.5, borderRadius: 1, backgroundColor: '#15151D', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1} mb={1.25}>
            <Box minWidth={0}>
              <Typography variant="subtitle1" fontWeight={700}>{selectedAgent?.name || 'Agent thread'}</Typography>
              <Typography variant="caption" color="text.secondary">{selectedTask?.title || 'No assigned task selected'}</Typography>
            </Box>
            <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 260 } }}>
              <InputLabel>Task</InputLabel>
              <Select label="Task" value={selectedTaskId} onChange={(event) => setSelectedTaskId(String(event.target.value))}>
                {assignedTasks.map((task) => <MenuItem key={task.id} value={task.id}>{task.title}</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>

          {selectedTask && (
            <Box sx={{ px: 1.25, py: 1, mb: 1.25, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.04)' }}>
              <Stack direction="row" spacing={1} flexWrap="wrap" mb={0.5}>
                <Chip size="small" label={selectedTask.status} />
                <Chip size="small" label={selectedTask.priority} />
                {selectedTask.dueDate && <Chip size="small" label={`Due ${selectedTask.dueDate}`} />}
              </Stack>
              {selectedTask.desc && <Typography variant="body2" color="text.secondary">{selectedTask.desc}</Typography>}
              {selectedTask.workItem?.nextAction && (
                <Typography variant="caption" color="text.primary" display="block" mt={0.75}>Next: {selectedTask.workItem.nextAction}</Typography>
              )}
              <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                Checklist: {(selectedTask.checklist || []).filter((item) => item.done).length}/{(selectedTask.checklist || []).length}
              </Typography>
            </Box>
          )}

          <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1.25 }} />
          <Stack spacing={1} sx={{ flex: 1, minHeight: 220, maxHeight: 380, overflowY: 'auto', pr: 0.5 }}>
            {!selectedTaskId ? (
              <Typography variant="body2" color="text.disabled">No open tasks assigned to this agent.</Typography>
            ) : messages.length === 0 ? (
              <Typography variant="body2" color="text.disabled">No task thread yet.</Typography>
            ) : messages.map((message) => (
              <Box key={message.id} sx={{ alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
                <Box sx={{ px: 1.2, py: 0.9, borderRadius: 1, backgroundColor: message.role === 'user' ? 'rgba(168,199,250,0.2)' : message.role === 'system' ? 'rgba(239,83,80,0.12)' : 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <Typography variant="body2" color="text.primary" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{message.text}</Typography>
                </Box>
                <Typography variant="caption" color="text.disabled" sx={{ px: 0.5 }}>{formatTimestamp(message.createdAt)}</Typography>
              </Box>
            ))}
          </Stack>

          <Stack direction="row" spacing={1} mt={1.25} alignItems="flex-end">
            <TextField
              size="small"
              placeholder={selectedTask ? `Message ${selectedAgent?.name || 'agent'} about this task` : 'Assign a task to start a thread'}
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  sendMessage()
                }
              }}
              fullWidth
              multiline
              minRows={1}
              maxRows={4}
              disabled={!selectedTaskId || !runtime?.ready || sending}
            />
            <Tooltip title="Send to assigned agent">
              <span>
                <IconButton
                  color="primary"
                  aria-label="Send to assigned agent"
                  onClick={sendMessage}
                  disabled={!selectedTaskId || !runtime?.ready || !composer.trim() || sending}
                  sx={{ width: 40, height: 40 }}
                >
                  {sending ? <CircularProgress size={20} /> : <SendRounded />}
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Card>
      </Box>

      <Typography variant="subtitle2" color="text.primary" mt={3} mb={1}>Open task ownership</Typography>
      <Stack spacing={0.75}>
        {openTasks.map((task) => (
          <Box key={task.id} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 220px' }, gap: 1, alignItems: 'center', px: 1.25, py: 1, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <Box minWidth={0}>
              <Typography variant="body2" fontWeight={600} noWrap>{task.title}</Typography>
              <Typography variant="caption" color="text.secondary">{task.status} | {task.priority}</Typography>
            </Box>
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

      <Snackbar open={Boolean(notice)} autoHideDuration={4000} onClose={() => setNotice('')} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
        <Alert severity="info" variant="filled" onClose={() => setNotice('')}>{notice}</Alert>
      </Snackbar>
    </Box>
  )
}
