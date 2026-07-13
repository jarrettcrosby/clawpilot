'use client'

import { useState, useEffect, createContext, useContext, useCallback } from 'react'
import type { FormEvent } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import useMediaQuery from '@mui/material/useMediaQuery'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import TextField from '@mui/material/TextField'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'
import AddRounded from '@mui/icons-material/AddRounded'
import {
  DndContext, DragEndEvent, DragStartEvent, DragOverlay,
  PointerSensor, TouchSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core'
import KanbanColumn from './KanbanColumn'
import KanbanCard from './KanbanCard'
import CardDetailDrawer from './CardDetailDrawer'
import SearchBar from './SearchBar'
import FilterBar, { BoardFilter, emptyFilter, isFilterActive } from './FilterBar'
import ArchivedCardsView from './ArchivedCardsView'
import DeletedCardsView from './DeletedCardsView'
import type { Task } from '@/lib/types'
import { ASSIGNABLE_PRODUCT_AGENT_IDS, COLUMNS, PEOPLE } from '@/lib/types'
import { assignmentKickoffText, triggerAgentTurn } from '@/lib/agents/client'

type BoardCtx = {
  updateTask: (task: Task) => void
  focusedTaskId: string | null
  setFocusedTaskId: (id: string) => void
  openDrawer: (id: string) => void
  notify: (message: string) => void
}

export const BoardContext = createContext<BoardCtx>({
  updateTask: () => {},
  focusedTaskId: null,
  setFocusedTaskId: () => {},
  openDrawer: () => {},
  notify: () => {},
})
export const useBoardContext = () => useContext(BoardContext)

type Props = { externalFilter?: BoardFilter; onFilterChange?: (filter: BoardFilter) => void }
type OpenTaskEvent = CustomEvent<{ id?: string }>
type NewTaskDraft = {
  title: string
  description: string
  priority: Task['priority']
  assignedAgent: string
  dueDate: string
  nextAction: string
  checklist: string
}

const EMPTY_NEW_TASK: NewTaskDraft = {
  title: '',
  description: '',
  priority: 'medium',
  assignedAgent: '',
  dueDate: '',
  nextAction: '',
  checklist: '',
}

const ASSIGNABLE_PEOPLE = PEOPLE.filter(person => (
  ASSIGNABLE_PRODUCT_AGENT_IDS.includes(person.id as typeof ASSIGNABLE_PRODUCT_AGENT_IDS[number])
))

export default function KanbanBoard({ externalFilter, onFilterChange }: Props = {}) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null)
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [archiveMode, setArchiveMode] = useState(false)
  const [archiveView, setArchiveView] = useState<'archived' | 'deleted'>('archived')
  const [internalFilter, setInternalFilter] = useState<BoardFilter>(emptyFilter())
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTask, setNewTask] = useState<NewTaskDraft>(EMPTY_NEW_TASK)
  const [creatingTask, setCreatingTask] = useState(false)
  const [createError, setCreateError] = useState('')
  const [moveError, setMoveError] = useState('')
  const isTouch = useMediaQuery('(pointer: coarse)')

  const filter = externalFilter && isFilterActive(externalFilter) ? externalFilter : internalFilter
  const drawerTask = tasks.find(task => task.id === drawerTaskId) || null

  useEffect(() => {
    if (!archiveMode) setArchiveView('archived')
  }, [archiveMode])

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    fetch('/api/tasks', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Unable to load tasks')
        return response.json()
      })
      .then(taskData => setTasks(Array.isArray(taskData) ? taskData : []))
      .catch(() => setTasks([]))
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
    setTasks(previous => previous.map(task => task.id === updated.id ? updated : task))
  }, [])

  const openDrawer = useCallback((id: string) => {
    setFocusedTaskId(id)
    setDrawerTaskId(id)
  }, [])

  useEffect(() => {
    function onOpenTask(event: Event) {
      const id = (event as OpenTaskEvent).detail?.id
      if (id) setPendingOpenId(String(id))
    }

    window.addEventListener('open-task', onOpenTask)
    return () => window.removeEventListener('open-task', onOpenTask)
  }, [])

  useEffect(() => {
    if (!pendingOpenId || !tasks.some(task => String(task.id) === pendingOpenId)) return
    openDrawer(pendingOpenId)
    setPendingOpenId(null)
  }, [pendingOpenId, tasks, openDrawer])

  const visibleTasks = tasks.filter(task => {
    if (task.archived) return false
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      const matches = task.title.toLowerCase().includes(query)
        || task.desc?.toLowerCase().includes(query)
        || task.tags?.some(tag => tag.toLowerCase().includes(query))
      if (!matches) return false
    }
    if (filter.status.length > 0) {
      if (filter.status.includes('active')) {
        if (task.status === 'done') return false
      } else if (!filter.status.includes(task.status)) return false
    }
    if (filter.priority.length > 0 && !filter.priority.includes(task.priority)) return false
    if (filter.labels.length > 0 && !filter.labels.every(label => task.tags?.includes(label))) return false
    return true
  })

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 10 } })
  const sensors = useSensors(...(isTouch ? [touchSensor] : [pointerSensor, touchSensor]))

  function handleFilterChange(nextFilter: BoardFilter) {
    setInternalFilter(nextFilter)
    onFilterChange?.(nextFilter)
  }

  function clearFilter() {
    const cleared = emptyFilter()
    setInternalFilter(cleared)
    onFilterChange?.(cleared)
  }

  function handleArchiveCard(archived: Task) {
    updateTask(archived)
    setDrawerTaskId(null)
  }

  function handleRestored(restored: Task) {
    updateTask(restored)
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveTask(tasks.find(task => String(task.id) === String(event.active.id)) || null)
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null)
    const { active, over } = event
    if (!over) return

    const dragged = tasks.find(task => String(task.id) === String(active.id))
    if (!dragged) return
    const targetStatus = COLUMNS.find(column => column.status === over.id)?.status
      || tasks.find(task => String(task.id) === String(over.id))?.status
    if (!targetStatus || targetStatus === dragged.status) return

    setTasks(previous => previous.map(task => task.id === dragged.id ? { ...task, status: targetStatus } : task))
    try {
      const response = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dragged.id, status: targetStatus, _actor: 'Jarrett' }),
      })
      const result = await response.json()
      if (!response.ok) {
        const message = result.operatorMessage || result.actionabilityGuard?.message || result.error || 'Unable to move task.'
        setMoveError(message)
        openDrawer(dragged.id)
        throw new Error(message)
      }
      updateTask(result as Task)
    } catch {
      setTasks(previous => previous.map(task => task.id === dragged.id ? { ...task, status: dragged.status } : task))
    }
  }

  function closeNewTask() {
    if (creatingTask) return
    setNewTaskOpen(false)
    setNewTask(EMPTY_NEW_TASK)
    setCreateError('')
  }

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = newTask.title.trim()
    if (title.replace(/[^a-z0-9]/gi, '').length < 3) {
      setCreateError('Enter a meaningful title.')
      return
    }

    const checklist = newTask.checklist
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map(text => ({ text, done: false }))

    setCreatingTask(true)
    setCreateError('')
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          desc: newTask.description.trim(),
          status: 'backlog',
          priority: newTask.priority,
          assignedAgent: newTask.assignedAgent || undefined,
          dueDate: newTask.dueDate || undefined,
          nextAction: newTask.nextAction.trim() || undefined,
          checklist,
          _actor: 'Jarrett',
          _createSource: 'manual-ui',
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.operatorMessage || result.error || 'Unable to create task.')
      }

      const created = result as Task
      setTasks(previous => [created, ...previous])
      setNewTask(EMPTY_NEW_TASK)
      setNewTaskOpen(false)
      openDrawer(String(created.id))
      if (created.assignedAgent) {
        try {
          await triggerAgentTurn({ taskId: created.id, agentId: created.assignedAgent, text: assignmentKickoffText() })
        } catch (error) {
          setMoveError(error instanceof Error ? `Task created, but agent kickoff failed: ${error.message}` : 'Task created, but agent kickoff failed.')
        }
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Unable to create task.')
    } finally {
      setCreatingTask(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <CircularProgress size={32} sx={{ color: '#A8C7FA' }} />
      </Box>
    )
  }

  return (
    <BoardContext.Provider value={{ updateTask, focusedTaskId, setFocusedTaskId, openDrawer, notify: setMoveError }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, backgroundColor: '#0F0F13', overflowY: { xs: 'auto', md: 'hidden' }, overflowX: 'hidden', WebkitOverflowScrolling: 'touch' }}>
        <Box sx={{ px: { xs: 2, md: 4 }, pt: { xs: 2, md: 3 }, pb: 2, flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <Stack spacing={1.5}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                <Typography variant="h5" fontWeight={700} color="text.primary">Projects</Typography>
                <Typography variant="body2" color="text.disabled">
                  {archiveMode ? 'Archive' : `${visibleTasks.length} task${visibleTasks.length === 1 ? '' : 's'}${isFilterActive(filter) ? ' (filtered)' : ''}`}
                </Typography>
              </Box>
              {!archiveMode && (
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<AddRounded />}
                  onClick={() => setNewTaskOpen(true)}
                  sx={{ textTransform: 'none', backgroundColor: '#A8C7FA', color: '#001D36', '&:hover': { backgroundColor: '#C2D7FA' } }}
                >
                  New task
                </Button>
              )}
            </Box>

            <SearchBar
              query={searchQuery}
              onSearch={setSearchQuery}
              archiveMode={archiveMode}
              onToggleArchive={() => setArchiveMode(current => !current)}
            />

            {archiveMode ? (
              <Stack direction="row" spacing={1}>
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
          </Stack>
        </Box>

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
                WebkitOverflowScrolling: 'touch', touchAction: 'pan-x', overscrollBehaviorX: 'contain',
                '&::-webkit-scrollbar': { height: 6 },
                '&::-webkit-scrollbar-thumb': { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3 },
              }}>
                {COLUMNS.map(column => (
                  <KanbanColumn
                    key={column.status}
                    status={column.status}
                    label={column.label}
                    color={column.color}
                    tasks={visibleTasks.filter(task => task.status === column.status)}
                  />
                ))}
              </Box>
            </Box>
            <DragOverlay>
              {activeTask ? <KanbanCard task={activeTask} /> : null}
            </DragOverlay>
          </DndContext>
        )}
      </Box>

      <Dialog open={newTaskOpen} onClose={closeNewTask} maxWidth="sm" fullWidth>
        <Box component="form" onSubmit={handleCreateTask}>
          <DialogTitle sx={{ pb: 1 }}>New task</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <TextField
                autoFocus
                required
                size="small"
                label="Title"
                value={newTask.title}
                onChange={event => setNewTask(current => ({ ...current, title: event.target.value }))}
              />
              <TextField
                size="small"
                label="Description"
                value={newTask.description}
                onChange={event => setNewTask(current => ({ ...current, description: event.target.value }))}
                multiline
                minRows={2}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
                <TextField
                  select
                  size="small"
                  label="Priority"
                  value={newTask.priority}
                  onChange={event => setNewTask(current => ({ ...current, priority: event.target.value as Task['priority'] }))}
                  sx={{ flex: 1 }}
                >
                  <MenuItem value="high">High</MenuItem>
                  <MenuItem value="medium">Medium</MenuItem>
                  <MenuItem value="low">Low</MenuItem>
                </TextField>
                <TextField
                  select
                  size="small"
                  label="Assigned agent"
                  value={newTask.assignedAgent}
                  onChange={event => setNewTask(current => ({ ...current, assignedAgent: event.target.value }))}
                  sx={{ flex: 1 }}
                >
                  <MenuItem value="">Unassigned</MenuItem>
                  {ASSIGNABLE_PEOPLE.map(person => <MenuItem key={person.id} value={person.id}>{person.name}</MenuItem>)}
                </TextField>
                <TextField
                  size="small"
                  label="Due date"
                  type="date"
                  value={newTask.dueDate}
                  onChange={event => setNewTask(current => ({ ...current, dueDate: event.target.value }))}
                  InputLabelProps={{ shrink: true }}
                  sx={{ flex: 1 }}
                />
              </Stack>
              <TextField
                size="small"
                label="Next action"
                value={newTask.nextAction}
                onChange={event => setNewTask(current => ({ ...current, nextAction: event.target.value }))}
              />
              <TextField
                size="small"
                label="Checklist"
                placeholder="One item per line"
                value={newTask.checklist}
                onChange={event => setNewTask(current => ({ ...current, checklist: event.target.value }))}
                multiline
                minRows={3}
              />
              {createError && <Typography variant="caption" color="error">{createError}</Typography>}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={closeNewTask} disabled={creatingTask} sx={{ textTransform: 'none' }}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={creatingTask} sx={{ textTransform: 'none', backgroundColor: '#A8C7FA', color: '#001D36' }}>
              {creatingTask ? 'Creating...' : 'Create task'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      {drawerTask && (
        <CardDetailDrawer
          task={drawerTask}
          open={drawerTaskId !== null}
          onClose={() => setDrawerTaskId(null)}
          onUpdate={updateTask}
          onArchive={handleArchiveCard}
        />
      )}
      <Snackbar open={Boolean(moveError)} autoHideDuration={5000} onClose={() => setMoveError('')} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
        <Alert severity="warning" variant="filled" onClose={() => setMoveError('')}>{moveError}</Alert>
      </Snackbar>
    </BoardContext.Provider>
  )
}
