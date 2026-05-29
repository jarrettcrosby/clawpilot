'use client'

import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { Task } from '@/lib/types'
import { STALE_TASK_HOURS, getTaskLastTouchedAt, getTaskStaleAgeHours } from '@/lib/staleTasks'

type Props = {
  tasks: Task[]
  onUpdate: (task: Task) => void
  onOpenTask: (taskId: string) => void
}

type ActionMode = 'blocked' | 'rescope' | null

function formatAge(hours: number) {
  if (hours < 24) return `${Math.round(hours)}h stale`
  const days = Math.floor(hours / 24)
  const remainder = Math.round(hours % 24)
  return remainder > 0 ? `${days}d ${remainder}h stale` : `${days}d stale`
}

function formatLastTouched(iso: string) {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return 'Last update unknown'
  return `Last activity ${new Date(ts).toLocaleString()}`
}

export default function NeedsAttentionPanel({ tasks, onUpdate, onOpenTask }: Props) {
  const [actionTask, setActionTask] = useState<Task | null>(null)
  const [actionMode, setActionMode] = useState<ActionMode>(null)
  const [noteInput, setNoteInput] = useState('')
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const openPrompt = (task: Task, mode: Exclude<ActionMode, null>) => {
    setActionTask(task)
    setActionMode(mode)
    setNoteInput('')
    setError(null)
  }

  const closePrompt = () => {
    if (savingTaskId) return
    setActionTask(null)
    setActionMode(null)
    setNoteInput('')
    setError(null)
  }

  async function patchTask(taskId: string, payload: Record<string, unknown>) {
    setSavingTaskId(taskId)
    setError(null)
    try {
      const response = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: taskId, _actor: 'Jarrett', ...payload }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(String(data?.error || 'Failed to update task'))
      }
      onUpdate(data as Task)
      closePrompt()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update task'
      setError(message)
    } finally {
      setSavingTaskId(null)
    }
  }

  async function handleImmediateAction(task: Task, mode: 'todo' | 'archive') {
    if (savingTaskId) return
    if (mode === 'todo') {
      await patchTask(task.id, {
        status: 'todo',
        _execution: {
          executionStatus: 'awaiting_input',
          latestExecutionNote: 'Next action: Re-plan scope before restarting work.',
        },
        _comment: 'Stale triage: moved back to To Do for re-planning.',
      })
      return
    }

    await patchTask(task.id, {
      _archive: true,
      _execution: {
        executionStatus: 'completed',
        latestExecutionNote: 'Archived during stale triage.',
      },
      _comment: 'Stale triage: archived due to inactivity.',
    })
  }

  async function submitPrompt() {
    if (!actionTask || !actionMode) return
    const value = noteInput.trim()
    if (!value) {
      setError(actionMode === 'blocked' ? 'Blocked reason is required.' : 'Next step is required.')
      return
    }

    if (actionMode === 'blocked') {
      const nextTags = Array.from(new Set([...(actionTask.tags || []), 'blocked']))
      await patchTask(actionTask.id, {
        tags: nextTags,
        _execution: {
          executionStatus: 'blocked',
          latestExecutionNote: `Blocker: ${value}`,
        },
        _comment: `Stale triage: blocked. Reason: ${value}`,
      })
      return
    }

    const nextTags = (actionTask.tags || []).filter((tag) => tag !== 'blocked')
    await patchTask(actionTask.id, {
      tags: nextTags,
      _execution: {
        executionStatus: 'awaiting_input',
        latestExecutionNote: `Next action: ${value}`,
      },
      _comment: `Stale triage: re-scoped. Next step: ${value}`,
    })
  }

  if (tasks.length === 0) return null

  return (
    <>
      <Card sx={{ mt: 1.5, p: { xs: 1, md: 1.25 }, backgroundColor: '#19171C', border: '1px solid rgba(255,183,77,0.18)', borderRadius: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ sm: 'center' }}>
          <Box>
            <Typography variant="overline" sx={{ fontSize: '0.62rem', letterSpacing: 1.4, color: '#FFB74D' }}>Needs Attention</Typography>
            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>
              Top stale in-progress tasks with no activity for {STALE_TASK_HOURS}+ hours
            </Typography>
          </Box>
          <Chip size="small" label={`${tasks.length} stale`} sx={{ backgroundColor: 'rgba(255,183,77,0.16)', color: '#FFB74D', border: '1px solid rgba(255,183,77,0.24)' }} />
        </Stack>

        <Stack spacing={0.75} sx={{ mt: 1 }}>
          {tasks.map((task) => {
            const staleHours = getTaskStaleAgeHours(task)
            const lastTouched = getTaskLastTouchedAt(task)
            const disabled = savingTaskId === task.id

            return (
              <Box key={task.id} sx={{ p: 1, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ md: 'center' }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{task.title}</Typography>
                      <Chip size="small" label={formatAge(staleHours)} sx={{ height: 20, fontSize: '0.64rem', backgroundColor: 'rgba(255,183,77,0.18)', color: '#FFB74D' }} />
                    </Stack>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {formatLastTouched(lastTouched)}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                    <Button size="small" variant="outlined" disabled={disabled} onClick={() => openPrompt(task, 'blocked')} sx={{ textTransform: 'none', fontSize: '0.68rem' }}>
                      Mark blocked
                    </Button>
                    <Button size="small" variant="outlined" disabled={disabled} onClick={() => openPrompt(task, 'rescope')} sx={{ textTransform: 'none', fontSize: '0.68rem' }}>
                      Re-scope
                    </Button>
                    <Button size="small" variant="text" disabled={disabled} onClick={() => void handleImmediateAction(task, 'todo')} sx={{ textTransform: 'none', fontSize: '0.68rem' }}>
                      Move to todo
                    </Button>
                    <Button size="small" variant="text" color="inherit" disabled={disabled} onClick={() => void handleImmediateAction(task, 'archive')} sx={{ textTransform: 'none', fontSize: '0.68rem', color: 'text.secondary' }}>
                      Archive
                    </Button>
                    <Button size="small" variant="text" disabled={disabled} onClick={() => onOpenTask(task.id)} sx={{ textTransform: 'none', fontSize: '0.68rem', minWidth: 0 }}>
                      Open
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            )
          })}
        </Stack>
      </Card>

      <Dialog open={Boolean(actionTask && actionMode)} onClose={closePrompt} fullWidth maxWidth="xs">
        <DialogTitle>{actionMode === 'blocked' ? 'Mark task blocked' : 'Re-scope task'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {actionMode === 'blocked'
                ? 'A short blocker reason is required before this task can be marked blocked.'
                : 'A concrete next step is required before this task is re-scoped.'}
            </Typography>
            <TextField
              autoFocus
              multiline
              minRows={2}
              value={noteInput}
              onChange={(event) => setNoteInput(event.target.value)}
              label={actionMode === 'blocked' ? 'Blocked reason' : 'Next step'}
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closePrompt} disabled={Boolean(savingTaskId)}>Cancel</Button>
          <Button variant="contained" onClick={() => void submitPrompt()} disabled={!noteInput.trim() || Boolean(savingTaskId)}>
            {actionMode === 'blocked' ? 'Save blocker' : 'Save next step'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
