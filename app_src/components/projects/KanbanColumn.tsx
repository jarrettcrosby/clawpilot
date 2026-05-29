'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import KanbanCard from './KanbanCard'
import type { Task } from '@/lib/types'

type Props = { status: Task['status']; label: string; color: string; tasks: Task[]; fullWidth?: boolean }

export default function KanbanColumn({ status, label, color, tasks, fullWidth }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: status })

  return (
    <Box sx={{
      minWidth: fullWidth ? '100%' : { xs: '82vw', sm: 272 },
      maxWidth: fullWidth ? '100%' : { xs: '82vw', sm: 272 },
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      height: '100%'
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, px: 0.5 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }} />
        <Typography variant="subtitle2" fontWeight={700} color="text.disabled"
          sx={{ textTransform: 'uppercase', fontSize: '0.68rem', letterSpacing: 1.2 }}>
          {label}
        </Typography>
        <Chip size="small" label={tasks.length}
          sx={{ height: 18, fontSize: '0.65rem', ml: 'auto', backgroundColor: 'rgba(255,255,255,0.06)', color: 'text.disabled', borderRadius: 1 }} />
      </Box>

      <Box ref={setNodeRef} sx={{
        flex: 1, overflowY: 'auto', px: 0.25, pb: 2, borderRadius: 3, transition: 'background-color 0.15s',
        WebkitOverflowScrolling: 'touch',
        // allow horizontal gestures to bubble to board scroller when starting on cards/column
        touchAction: 'auto',
        backgroundColor: isOver ? 'rgba(168,199,250,0.04)' : 'transparent',
        border: isOver ? '1px dashed rgba(168,199,250,0.2)' : '1px dashed transparent',
        minHeight: 80,
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(168,199,250,0.28) transparent',
        '&::-webkit-scrollbar': { width: 8 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': { backgroundColor: 'rgba(168,199,250,0.28)', borderRadius: 8, border: '2px solid transparent', backgroundClip: 'padding-box' },
      }}>
        <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map(task => <KanbanCard key={task.id} task={task} />)}
          {tasks.length === 0 && (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="caption" color="text.disabled">Drop here</Typography>
            </Box>
          )}
        </SortableContext>
      </Box>
    </Box>
  )
}
