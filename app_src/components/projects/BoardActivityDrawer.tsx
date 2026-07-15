'use client'

import { useMemo } from 'react'
import Drawer from '@mui/material/Drawer'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import CloseRounded from '@mui/icons-material/CloseRounded'
import SwapHorizRounded from '@mui/icons-material/SwapHorizRounded'
import AddCircleOutlineRounded from '@mui/icons-material/AddCircleOutlineRounded'
import LabelRounded from '@mui/icons-material/LabelRounded'
import ChatBubbleOutlineRounded from '@mui/icons-material/ChatBubbleOutlineRounded'
import AccessTimeRounded from '@mui/icons-material/AccessTimeRounded'
import SmartToyRounded from '@mui/icons-material/SmartToyRounded'
import CheckBoxRounded from '@mui/icons-material/CheckBoxRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import type { Task, ActivityEntry } from '@/lib/types'
import { PEOPLE, STATUS_LABELS } from '@/lib/types'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'

type Props = { open: boolean; onClose: () => void; tasks: Task[] }

type FlatEntry = ActivityEntry & { _taskTitle: string; _taskId: string }

function formatDate(iso: string, settings: UserDateTimeSettings) {
  return formatUserDateTime(iso, settings, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    fallback: 'Unknown time',
  })
}

function ActorAvatar({ actor }: { actor: string }) {
  const person = PEOPLE.find(p => p.id === actor || p.name === actor)
  const color = person?.color || '#A8C7FA'
  const botIds = new Set(['clawpilot', 'projects', 'pipeline', 'docs', 'calendar'])
  const isBot = person?.id ? botIds.has(person.id) : false
  const initials = person?.initials || actor?.slice(0, 2).toUpperCase() || '?'

  return (
    <Box sx={{ width: 30, height: 30, borderRadius: '50%', backgroundColor: color + '22', border: `1px solid ${color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {isBot ? (
        <SmartToyRounded sx={{ fontSize: 16, color }} />
      ) : (
        <Typography variant="caption" sx={{ color, fontWeight: 700, fontSize: '0.68rem' }}>{initials.slice(0, 1)}</Typography>
      )}
    </Box>
  )
}

function ActivityIcon({ type }: { type: string }) {
  const sx = { fontSize: 14 }
  if (type === 'moved') return <SwapHorizRounded sx={{ ...sx, color: '#A8C7FA' }} />
  if (type === 'label_added' || type === 'label_removed') return <LabelRounded sx={{ ...sx, color: '#CFC6EA' }} />
  if (type === 'created') return <AddCircleOutlineRounded sx={{ ...sx, color: '#66BB6A' }} />
  if (type === 'comment') return <ChatBubbleOutlineRounded sx={{ ...sx, color: '#FFA726' }} />
  if (type === 'checklist') return <CheckBoxRounded sx={{ ...sx, color: '#AB47BC' }} />
  if (type === 'updated') return <EditRounded sx={{ ...sx, color: '#78909C' }} />
  return <AccessTimeRounded sx={{ ...sx, color: 'rgba(255,255,255,0.3)' }} />
}

export default function BoardActivityDrawer({ open, onClose, tasks }: Props) {
  const dateTimeSettings = useUserDateTime()
  const allActivity = useMemo<FlatEntry[]>(() => {
    const entries: FlatEntry[] = []
    for (const task of tasks) {
      for (const entry of task.activity || []) {
        entries.push({ ...entry, _taskTitle: task.title, _taskId: task.id })
      }
    }
    return entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  }, [tasks])

  // Group by date
  const grouped = useMemo(() => {
    const groups: Record<string, FlatEntry[]> = {}
    for (const entry of allActivity) {
      const day = formatUserDateTime(entry.timestamp, dateTimeSettings, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        fallback: 'Unknown date',
      })
      if (!groups[day]) groups[day] = []
      groups[day].push(entry)
    }
    return groups
  }, [allActivity, dateTimeSettings])

  return (
    <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{
      sx: { width: { xs: '100vw', sm: 420 }, backgroundColor: '#1A1A23', borderLeft: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }
    }}>
      {/* Header */}
      <Box sx={{ px: 3, pt: 3, pb: 2, borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="h6" fontWeight={700} color="text.primary">Board Activity</Typography>
            <Typography variant="caption" color="text.disabled">{allActivity.length} events across {tasks.length} cards</Typography>
          </Box>
          <IconButton onClick={onClose} sx={{ color: 'text.disabled' }}><CloseRounded /></IconButton>
        </Box>
        {/* People legend */}
        <Stack direction="row" spacing={1} flexWrap="wrap" mt={1.5} gap={0.5}>
          {PEOPLE.map(p => (
            <Chip key={p.id} size="small" label={p.name}
              sx={{ height: 22, fontSize: '0.68rem', borderRadius: 1.5, border: 'none',
                backgroundColor: p.color + '18', color: p.color }} />
          ))}
        </Stack>
      </Box>

      {/* Activity list */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 2.5, py: 2 }}>
        {Object.entries(grouped).map(([day, entries]) => (
          <Box key={day} mb={3}>
            <Typography variant="overline" color="text.disabled"
              sx={{ fontSize: '0.62rem', letterSpacing: 1.5, display: 'block', mb: 1.5, px: 0.5 }}>
              {day}
            </Typography>
            <Stack spacing={0}>
              {entries.map((entry, i) => (
                <Box key={i}>
                  <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', py: 1.25, px: 0.5 }}>
                    <ActorAvatar actor={entry.actor || 'Jarrett'} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" mb={0.25}>
                        <Typography variant="body2" fontWeight={600} color="text.primary" sx={{ fontSize: '0.8rem' }}>
                          {entry.actor || 'Jarrett'}
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                          <ActivityIcon type={entry.type} />
                        </Box>
                        <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.8rem' }}>
                          {entry.message}
                        </Typography>
                      </Stack>
                      {/* Card reference */}
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.68rem' }}>
                          {formatDate(entry.timestamp, dateTimeSettings)}
                        </Typography>
                        <Typography variant="caption" sx={{ fontSize: '0.68rem', color: 'rgba(168,199,250,0.5)' }}>·</Typography>
                        <Typography variant="caption" sx={{ fontSize: '0.68rem', color: '#A8C7FA', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                          {entry._taskTitle || entry.taskTitle}
                        </Typography>
                      </Stack>
                      {/* Move chips */}
                      {entry.from && entry.to && (
                        <Stack direction="row" spacing={0.5} alignItems="center" mt={0.5}>
                          <Chip size="small" label={STATUS_LABELS[entry.from as Task['status']] || entry.from} variant="outlined"
                            sx={{ height: 18, fontSize: '0.62rem', borderColor: 'rgba(255,255,255,0.1)', color: 'text.disabled', borderRadius: 1 }} />
                          <SwapHorizRounded sx={{ fontSize: 12, color: 'text.disabled' }} />
                          <Chip size="small" label={STATUS_LABELS[entry.to as Task['status']] || entry.to}
                            sx={{ height: 18, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(168,199,250,0.1)', color: '#A8C7FA', border: 'none' }} />
                        </Stack>
                      )}
                    </Box>
                  </Box>
                  {i < entries.length - 1 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.04)', ml: 5.5 }} />}
                </Box>
              ))}
            </Stack>
          </Box>
        ))}
        {allActivity.length === 0 && (
          <Box sx={{ textAlign: 'center', pt: 8 }}>
            <Typography variant="body2" color="text.disabled">No activity yet</Typography>
          </Box>
        )}
      </Box>
    </Drawer>
  )
}
