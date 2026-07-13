'use client'

import { useState } from 'react'
import Box from '@mui/material/Box'
import useMediaQuery from '@mui/material/useMediaQuery'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Popover from '@mui/material/Popover'
import MenuItem from '@mui/material/MenuItem'
import ButtonBase from '@mui/material/ButtonBase'
import OpenInFullRounded from '@mui/icons-material/OpenInFullRounded'
import DragIndicatorRounded from '@mui/icons-material/DragIndicatorRounded'
import PersonAddAlt1Rounded from '@mui/icons-material/PersonAddAlt1Rounded'
import CalendarTodayRounded from '@mui/icons-material/CalendarTodayRounded'
import ForumRounded from '@mui/icons-material/ForumRounded'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Task } from '@/lib/types'
import { ASSIGNABLE_PRODUCT_AGENT_IDS, PRIORITY_COLORS, PRIORITY_LABELS, PEOPLE } from '@/lib/types'
import { useBoardContext } from './KanbanBoard'
import { displayCategory } from '@/lib/format'
import { queueAgentTaskOpen } from '@/lib/agents/navigation'
import { assignmentKickoffText, triggerAgentTurn } from '@/lib/agents/client'

type Props = { task: Task }

export default function KanbanCard({ task }: Props) {
  const { focusedTaskId, setFocusedTaskId, openDrawer, updateTask, notify } = useBoardContext()
  const [assignAnchor, setAssignAnchor] = useState<HTMLElement | null>(null)
  const isFocused = focusedTaskId === task.id
  const isTouch = useMediaQuery('(pointer: coarse)')

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const showCategoryChip = Boolean(task.category) && task.category !== 'clawpilot'

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  async function assignTo(personId: string) {
    setAssignAnchor(null)
    const r = await fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, assignedAgent: personId, _actor: 'Jarrett' }),
    })
    const updated = await r.json()
    if (!r.ok) {
      notify(updated?.error || 'Unable to assign task.')
      return
    }
    updateTask(updated)
    try {
      await triggerAgentTurn({ taskId: task.id, agentId: personId, text: assignmentKickoffText() })
    } catch (error) {
      notify(error instanceof Error ? `Task assigned, but agent kickoff failed: ${error.message}` : 'Task assigned, but agent kickoff failed.')
    }
  }

  function openAgentChat() {
    const agentId = task.assignedAgent || ''
    queueAgentTaskOpen(task.id, agentId)
    window.location.hash = 'agents'
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('open-agent-task', { detail: { taskId: task.id, agentId } }))
    }, 120)
  }

  return (
    <div ref={setNodeRef} style={style}>
      <Box
        id={'kanban-card-' + task.id}
        onClick={() => {
          setFocusedTaskId(task.id)
          openDrawer(task.id)
        }}
        sx={{
          backgroundColor: '#1A1A23',
          border: '1px solid',
          borderColor: isDragging
            ? 'rgba(168,199,250,0.4)'
            : isFocused
              ? 'rgba(168,199,250,0.6)'
              : 'rgba(255,255,255,0.06)',
          boxShadow: isFocused
            ? '0 0 0 2px rgba(168,199,250,0.15)'
            : isDragging
              ? '0 8px 24px rgba(0,0,0,0.4)'
              : 'none',
          borderRadius: 1, p: 1.75, mb: 1.25, userSelect: 'none',
          touchAction: 'auto',
          cursor: 'pointer',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          '&:hover': { borderColor: isFocused ? 'rgba(168,199,250,0.6)' : 'rgba(168,199,250,0.2)' },
        }}>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
          {/* Drag handle */}
          <Tooltip title={isTouch ? 'Long-press handle to move' : 'Drag to move'}>
            <Box {...listeners} {...attributes}
              onClick={e => e.stopPropagation()}
              sx={{
                color: 'rgba(255,255,255,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'grab', '&:active': { cursor: 'grabbing' }, mr: 0.5,
                touchAction: 'none',
                minWidth: { xs: 40, md: 28 }, minHeight: { xs: 40, md: 28 }, borderRadius: 1.5,
                '&:hover': { color: 'rgba(255,255,255,0.6)', backgroundColor: 'rgba(255,255,255,0.05)' },
              }}>
              <DragIndicatorRounded sx={{ fontSize: { xs: 22, md: 18 } }} />
            </Box>
          </Tooltip>
          <Box sx={{ flex: 1 }} />

          {/* Expand — opens drawer */}
          <Tooltip title="Open detail (Enter)">
            <IconButton
              size="small"
              onClick={e => { e.stopPropagation(); openDrawer(task.id) }}
              sx={{ p: 0.5, color: 'rgba(255,255,255,0.2)', '&:hover': { color: '#A8C7FA', backgroundColor: 'rgba(168,199,250,0.08)' } }}
            >
              <OpenInFullRounded sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </Box>

        <Typography variant="body2" fontWeight={600} color="text.primary" sx={{ mb: 0.5, lineHeight: 1.4 }}>
          {task.title}
        </Typography>

        <Typography variant="caption" color="text.disabled" sx={{
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.5, mb: 1,
        }}>
          {task.desc}
        </Typography>

        {task.workItem?.nextAction && (
          <Typography variant="caption" color="text.secondary" sx={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: '0.66rem', mb: 0.75 }}>
            Next: {task.workItem.nextAction}
          </Typography>
        )}

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
          {showCategoryChip && (
            <Chip size="small" label={displayCategory(task.category)} variant="outlined"
              sx={{ height: 20, fontSize: '0.65rem', borderColor: 'rgba(255,255,255,0.1)', color: 'text.disabled', borderRadius: 1 }} />
          )}
          <Chip size="small" label={PRIORITY_LABELS[task.priority]}
            sx={{ height: 20, fontSize: '0.65rem', borderRadius: 1, backgroundColor: PRIORITY_COLORS[task.priority] + '22', color: PRIORITY_COLORS[task.priority], border: 'none' }} />
        </Box>

        {/* Assignee + Due Date */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1, pt: 1, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          {task.assignedAgent ? (() => {
              const assigned = task.assignedAgent
              const p = PEOPLE.find(x => x.id === assigned || x.name === assigned)
              const color = p?.color || '#A8C7FA'
              const initials = p?.initials || String(assigned).slice(0, 2).toUpperCase()
              const label = p?.name || assigned
              return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 18, height: 18, borderRadius: '50%', backgroundColor: color + '22', border: `1px solid ${color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Typography sx={{ color, fontWeight: 700, fontSize: '0.52rem', lineHeight: 1 }}>{initials}</Typography>
                  </Box>
                  <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.68rem' }}>{label}</Typography>
                </Box>
              )
          })() : (
            <Tooltip title="Assign task">
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); setAssignAnchor(e.currentTarget) }} sx={{ p: 0.3, color: 'rgba(255,255,255,0.45)', '&:hover': { color: '#A8C7FA', backgroundColor: 'rgba(168,199,250,0.08)' } }}>
                <PersonAddAlt1Rounded sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
          )}
          {task.dueDate && (() => {
              const due = new Date(task.dueDate + 'T12:00:00')
              const now = new Date()
              const isOverdue = due < now
              const isSoon = !isOverdue && (due.getTime() - now.getTime()) < 2 * 24 * 60 * 60 * 1000
              const color = isOverdue ? '#EF5350' : isSoon ? '#FFA726' : 'rgba(255,255,255,0.35)'
              const label = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <CalendarTodayRounded sx={{ fontSize: 10, color }} />
                  <Typography variant="caption" sx={{ color, fontSize: '0.68rem', fontWeight: isOverdue || isSoon ? 600 : 400 }}>{label}</Typography>
                </Box>
              )
          })()}
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.6, mt: 0.6 }}>
          {task.assignedAgent && (
            <ButtonBase
              onClick={(e) => { e.stopPropagation(); openAgentChat() }}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                px: 0.75,
                py: 0.35,
                borderRadius: 1,
                border: '1px solid rgba(168,199,250,0.35)',
                color: '#A8C7FA',
                fontSize: '0.66rem',
                '&:hover': { backgroundColor: 'rgba(168,199,250,0.08)' },
              }}
            >
              <ForumRounded sx={{ fontSize: 12 }} />
              Open chat
            </ButtonBase>
          )}
        </Box>

        {/* Checklist mini progress */}
        {task.checklist && task.checklist.length > 0 && (() => {
          const done = task.checklist.filter(c => c.done).length
          const total = task.checklist.length
          const pct = Math.round((done / total) * 100)
          return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.75 }}>
              <Box sx={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <Box sx={{ height: '100%', width: `${pct}%`, backgroundColor: pct === 100 ? '#66BB6A' : '#A8C7FA', borderRadius: 2, transition: 'width 0.3s' }} />
              </Box>
              <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.62rem', whiteSpace: 'nowrap' }}>{done}/{total}</Typography>
            </Box>
          )
        })()}
      </Box>

      <Popover
        open={Boolean(assignAnchor)}
        anchorEl={assignAnchor}
        onClose={() => setAssignAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        PaperProps={{ sx: { backgroundColor: '#232330', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 2, p: 0.5, minWidth: 170 } }}
      >
        {PEOPLE.filter((p) => ASSIGNABLE_PRODUCT_AGENT_IDS.includes(p.id as typeof ASSIGNABLE_PRODUCT_AGENT_IDS[number])).map((p) => (
          <MenuItem key={p.id} onClick={() => assignTo(p.id)} sx={{ fontSize: '0.8rem' }}>{p.name}</MenuItem>
        ))}
      </Popover>
    </div>
  )
}
