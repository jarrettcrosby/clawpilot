'use client'

import { useState, useEffect } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Chip from '@mui/material/Chip'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import InboxRounded from '@mui/icons-material/InboxRounded'
import UnarchiveRounded from '@mui/icons-material/UnarchiveRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import type { Task } from '@/lib/types'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'

type Props = { query: string; onRestored: (t: Task) => void }

function formatDate(iso: string, settings: UserDateTimeSettings) {
  return formatUserDateTime(iso, settings, {
    month: 'short', day: 'numeric', year: 'numeric', fallback: 'Unknown date',
  })
}

const CATEGORY_COLORS: Record<string, string> = {
  clawpilot: '#CFC6EA', epi: '#66BB6A', suburbia: '#FDD663',
  p9ine: '#29B6F6', personal: '#A8C7FA', ops: '#FF8A65',
  tech: '#5C6BC0', marketing: '#EC407A',
}

export default function ArchivedCardsView({ query, onRestored }: Props) {
  const dateTimeSettings = useUserDateTime()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    fetch('/api/tasks?includeArchived=true&includeCrmCards=true')
      .then(r => r.json())
      .then((data: Task[]) => {
        setTasks(data.filter(t => t.archived))
        setLoading(false)
      })
  }, [])

  const filtered = tasks.filter(t => {
    if (!query) return true
    const q = query.toLowerCase()
    return t.title.toLowerCase().includes(q) ||
      t.desc?.toLowerCase().includes(q) ||
      t.tags?.some(tag => tag.toLowerCase().includes(q))
  })

  async function handleRestore(task: Task) {
    setRestoring(task.id)
    const res = await fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, _unarchive: true, _actor: 'Jarrett' }),
    })
    const updated: Task = await res.json()
    setTasks(prev => prev.filter(t => t.id !== task.id))
    setRestoring(null)
    onRestored(updated)
  }

  async function handlePermanentDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    await fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: deleteTarget.id, _deletePermanent: true, _actor: 'Jarrett' }),
    })
    setTasks(prev => prev.filter(t => t.id !== deleteTarget.id))
    setDeleting(false)
    setDeleteTarget(null)
  }

  if (loading) return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', pt: 8 }}>
      <CircularProgress size={28} sx={{ color: '#A8C7FA' }} />
    </Box>
  )

  return (
    <Box sx={{ flex: 1, px: { xs: 2, md: 4 }, py: 2, overflowY: 'auto' }}>
      <Typography variant="body2" color="text.disabled" sx={{ mb: 2 }}>
        {filtered.length} archived card{filtered.length !== 1 ? 's' : ''}
      </Typography>

      {filtered.length === 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 8, gap: 2 }}>
          <InboxRounded sx={{ fontSize: 48, color: 'text.disabled', opacity: 0.4 }} />
          <Typography color="text.disabled" variant="body2">No archived cards</Typography>
        </Box>
      ) : (
        <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {filtered.map(task => (
            <ListItem
              key={task.id}
              disablePadding
              sx={{
                backgroundColor: '#1A1A23',
                borderRadius: 2,
                border: '1px solid rgba(255,255,255,0.06)',
                px: 2, py: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <ListItemText
                primary={
                  <Typography variant="body2" fontWeight={600} color="text.primary" sx={{ mb: 0.5 }}>
                    {task.title}
                  </Typography>
                }
                secondary={
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip
                      label={task.category}
                      size="small"
                      sx={{
                        height: 20, fontSize: 11,
                        backgroundColor: `${CATEGORY_COLORS[task.category] || '#A8C7FA'}22`,
                        color: CATEGORY_COLORS[task.category] || '#A8C7FA',
                        fontWeight: 600,
                      }}
                    />
                    {task.archivedAt && (
                      <Typography variant="caption" color="text.disabled">
                        Archived {formatDate(task.archivedAt, dateTimeSettings)}
                      </Typography>
                    )}
                  </Box>
                }
                disableTypography
              />
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Button
                  size="small"
                  startIcon={restoring === task.id ? <CircularProgress size={12} /> : <UnarchiveRounded sx={{ fontSize: 16 }} />}
                  disabled={restoring === task.id}
                  onClick={() => handleRestore(task)}
                  sx={{
                    flexShrink: 0,
                    minHeight: 36,
                    fontSize: 12,
                    color: '#A8C7FA',
                    borderColor: 'rgba(168,199,250,0.3)',
                    border: '1px solid',
                    borderRadius: 1.5,
                    px: 1.5,
                    '&:hover': { backgroundColor: 'rgba(168,199,250,0.1)' },
                  }}
                >
                  Restore
                </Button>
                <Button
                  size="small"
                  color="error"
                  variant="outlined"
                  onClick={() => setDeleteTarget(task)}
                  sx={{
                    flexShrink: 0,
                    minHeight: 36,
                    fontSize: 12,
                    borderRadius: 1.5,
                    px: 1.5,
                  }}
                >
                  Delete permanently
                </Button>
              </Box>
            </ListItem>
          ))}
        </List>
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete permanently?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            This will permanently delete the archived card and cannot be undone.
          </Typography>
          {deleteTarget && (
            <Typography variant="body2" sx={{ mt: 1, fontWeight: 600 }}>
              {deleteTarget.title}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} sx={{ color: 'text.secondary' }}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handlePermanentDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
