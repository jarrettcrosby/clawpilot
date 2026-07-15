'use client'

import { useState, useEffect } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import DeleteForeverRounded from '@mui/icons-material/DeleteForeverRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'

type DeletedCard = {
  id: string
  title: string
  category?: string
  deletedAt: string
  actor?: string
  archivedAt?: string | null
  activity?: { type: string; message: string; timestamp: string }[]
}

type Props = { query: string }

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

export default function DeletedCardsView({ query }: Props) {
  const dateTimeSettings = useUserDateTime()
  const [items, setItems] = useState<DeletedCard[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/deleted-tasks')
      .then(r => r.json())
      .then((data: DeletedCard[]) => {
        setItems(Array.isArray(data) ? data : [])
        setLoading(false)
      })
  }, [])

  const filtered = items.filter(t => {
    if (!query) return true
    const q = query.toLowerCase()
    return t.title?.toLowerCase().includes(q) || t.id?.toLowerCase().includes(q)
  })

  if (loading) return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', pt: 8 }}>
      <CircularProgress size={28} sx={{ color: '#A8C7FA' }} />
    </Box>
  )

  return (
    <Box sx={{ flex: 1, px: { xs: 2, md: 4 }, py: 2, overflowY: 'auto' }}>
      <Typography variant="body2" color="text.disabled" sx={{ mb: 2 }}>
        {filtered.length} deleted card{filtered.length !== 1 ? 's' : ''} (read-only)
      </Typography>

      {filtered.length === 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 8, gap: 2 }}>
          <DeleteForeverRounded sx={{ fontSize: 48, color: 'text.disabled', opacity: 0.4 }} />
          <Typography color="text.disabled" variant="body2">No deleted cards</Typography>
        </Box>
      ) : (
        <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {filtered.map(task => {
            const lastActivity = task.activity?.[task.activity.length - 1]
            return (
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
                      {task.category && (
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
                      )}
                      <Typography variant="caption" color="text.disabled">
                        Deleted {formatDate(task.deletedAt, dateTimeSettings)}
                      </Typography>
                      {task.actor && (
                        <Typography variant="caption" color="text.disabled">
                          by {task.actor}
                        </Typography>
                      )}
                      <Typography variant="caption" color="text.disabled">
                        ID {task.id}
                      </Typography>
                      {lastActivity?.message && (
                        <Typography variant="caption" color="text.secondary">
                          {lastActivity.message}
                        </Typography>
                      )}
                    </Box>
                  }
                  disableTypography
                />
              </ListItem>
            )}
          )}
        </List>
      )}
    </Box>
  )
}
