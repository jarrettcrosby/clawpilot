'use client'
import {useEffect, useState} from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Checkbox from '@mui/material/Checkbox'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import PersonAddAlt1Rounded from '@mui/icons-material/PersonAddAlt1Rounded'
import CalendarTodayRounded from '@mui/icons-material/CalendarTodayRounded'
import type { ChecklistItem } from '@/lib/types'

export default function ReadOnlyChecklist({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/checklist/${taskId}`)
      if (!r.ok) { setItems([]); setLoading(false); return }
      const j = await r.json()
      if (j && Array.isArray(j.checklist)) setItems(j.checklist)
    } catch (e) {
      setItems([])
    } finally { setLoading(false) }
  }

  useEffect(() => {
    let mounted = true
    if (taskId) load()
    return () => { mounted = false }
  }, [taskId])

  if (loading) return <Typography variant="body2" color="text.disabled">Loading checklist…</Typography>
  if (!items || items.length === 0) return <Typography variant="caption" color="text.disabled">No checklist items</Typography>

  async function toggleItem(it: ChecklistItem) {
    if (!it || !it.id) return
    setToggling(it.id)
    try {
      // use existing task PATCH toggle - keeps persistence path small and safe
      const r = await fetch('/api/tasks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _checklistToggle: it.id, _actor: 'Jarrett' }) })
      if (r.ok) {
        // reload checklist to reflect persisted state
        await load()
      }
    } catch (e) {
      // noop
    } finally {
      setToggling(null)
    }
  }

  return (
    <Stack spacing={0.5} mb={1}>
      {items.map(it => (
        <Box key={it.id} sx={{ display:'flex', alignItems:'center', gap:1, py:0.5, px:0.5, borderRadius:1 }}>
          <Checkbox size="small" checked={!!it.done} disabled={!!toggling && toggling !== it.id} onChange={() => toggleItem(it)} sx={{ p:0.5 }} />
          <Box sx={{ flex:1 }}>
            <Typography variant="body2" color={it.done ? 'text.disabled' : 'text.primary'} sx={{ fontSize:'0.85rem' }}>{it.text}</Typography>
            <Box sx={{ display:'flex', gap:1, alignItems:'center', mt:0.25 }}>
              {it.assignee && (
                <Tooltip title={it.assignee}>
                  <PersonAddAlt1Rounded sx={{ fontSize: 12, color:'rgba(255,255,255,0.45)' }} />
                </Tooltip>
              )}
              {it.dueDate && (
                <Box sx={{ display:'flex', alignItems:'center', gap:0.5 }}>
                  <CalendarTodayRounded sx={{ fontSize: 12, color:'rgba(255,255,255,0.45)' }} />
                  <Typography variant="caption" color="text.disabled">{new Date(it.dueDate).toLocaleDateString()}</Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      ))}
    </Stack>
  )
}
