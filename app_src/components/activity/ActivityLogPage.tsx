'use client'

import { useState, useMemo, useEffect } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Divider from '@mui/material/Divider'
import Snackbar from '@mui/material/Snackbar'
import Alert from '@mui/material/Alert'
import DoneAllRounded from '@mui/icons-material/DoneAllRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import SwapHorizRounded from '@mui/icons-material/SwapHorizRounded'
import AddCircleOutlineRounded from '@mui/icons-material/AddCircleOutlineRounded'
import LabelRounded from '@mui/icons-material/LabelRounded'
import ChatBubbleOutlineRounded from '@mui/icons-material/ChatBubbleOutlineRounded'
import AccessTimeRounded from '@mui/icons-material/AccessTimeRounded'
import CheckBoxRounded from '@mui/icons-material/CheckBoxRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import ViewKanbanRounded from '@mui/icons-material/ViewKanbanRounded'
import { PEOPLE } from '@/lib/types'
import type { Task } from '@/lib/types'

const READ_KEY = 'clawpilot_read_log'
function getReadIds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]')) } catch { return new Set() }
}
function saveReadIds(ids: Set<string>) {
  try { localStorage.setItem(READ_KEY, JSON.stringify([...ids])) } catch {}
}

type LogEntry = {
  _id: string; _taskId: string; _taskTitle: string; _module: string
  type: string; message: string; timestamp: string; actor: string
  from?: string; to?: string
}

const TYPE_LABELS: Record<string, string> = {
  moved: 'Moved', comment: 'Comment', label_added: 'Label Added',
  label_removed: 'Label Removed', created: 'Created', updated: 'Updated', checklist: 'Checklist',
}
const TYPE_COLORS: Record<string, string> = {
  moved: '#A8C7FA', comment: '#FFA726', label_added: '#CFC6EA',
  label_removed: '#78909C', created: '#66BB6A', updated: '#78909C', checklist: '#AB47BC',
}
const MODULE_LABELS: Record<string, string> = {
  all: 'All Modules', projects: 'Projects', docs: 'Docs',
  pipeline: 'Pipeline', agents: 'Agents', dashboard: 'Dashboard',
}

function TypeIcon({ type }: { type: string }) {
  const sx = { fontSize: 14, color: TYPE_COLORS[type] || 'rgba(255,255,255,0.4)' }
  if (type === 'moved') return <SwapHorizRounded sx={sx} />
  if (type === 'label_added' || type === 'label_removed') return <LabelRounded sx={sx} />
  if (type === 'created') return <AddCircleOutlineRounded sx={sx} />
  if (type === 'comment') return <ChatBubbleOutlineRounded sx={sx} />
  if (type === 'checklist') return <CheckBoxRounded sx={sx} />
  if (type === 'updated') return <EditRounded sx={sx} />
  return <AccessTimeRounded sx={sx} />
}

function ActorBadge({ actor }: { actor: string }) {
  const person = PEOPLE.find(p => p.name.toLowerCase() === actor?.toLowerCase() || p.id === actor)
  const color = person?.color || '#A8C7FA'
  const initials = person?.initials || actor?.slice(0,2).toUpperCase() || 'J'
  const name = person?.name || actor || 'Jarrett'
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexShrink:0 }}>
      <Box sx={{ width:22, height:22, borderRadius:'50%', backgroundColor:color+'22', border:`1px solid ${color}44`, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <Typography sx={{ color, fontWeight:700, fontSize:'0.58rem', lineHeight:1 }}>{initials}</Typography>
      </Box>
      <Typography variant="caption" sx={{ color, fontWeight:600, fontSize:'0.72rem', whiteSpace:'nowrap' }}>{name}</Typography>
    </Stack>
  )
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
}

type PipelineActivityEntry = {
  id: string
  module: 'pipeline'
  type: string
  message: string
  timestamp: string
  actor: string
  opportunityName?: string
  organization?: string
  fromStage?: string
  toStage?: string
}

type Props = { tasks: Task[]; pipelineEntries?: PipelineActivityEntry[]; defaultModule?: string; onClose?: () => void }

export default function ActivityLogPage({ tasks, pipelineEntries = [], defaultModule, onClose }: Props) {
  const [readIds, setReadIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [filterModule, setFilterModule] = useState('all')
  const [userChangedModule, setUserChangedModule] = useState(false)
  const [filterType, setFilterType] = useState('all')
  const [filterActor, setFilterActor] = useState('all')
  const [readFilter, setReadFilter] = useState<'all'|'unread'|'read'>('all')
  const [missingTarget, setMissingTarget] = useState<string | null>(null)

  useEffect(() => { setReadIds(getReadIds()) }, [])
  useEffect(() => { if (!userChangedModule) setFilterModule('all') }, [defaultModule, userChangedModule])

  const allEntries = useMemo<LogEntry[]>(() => {
    const out: LogEntry[] = []
    for (const task of tasks) {
      for (const e of task.activity || []) {
        out.push({
          _id: `${task.id}-${e.timestamp}-${e.type}`,
          _taskId: task.id, _taskTitle: task.title, _module: 'projects',
          type: e.type, message: e.message, timestamp: e.timestamp,
          actor: e.actor || 'Jarrett', from: e.from, to: e.to,
        })
      }
    }

    for (const e of pipelineEntries) {
      out.push({
        _id: e.id,
        _taskId: e.id,
        _taskTitle: e.opportunityName || e.organization || 'Pipeline Opportunity',
        _module: 'pipeline',
        type: e.type,
        message: e.message,
        timestamp: e.timestamp,
        actor: e.actor || 'Jarrett',
        from: e.fromStage,
        to: e.toStage,
      })
    }

    return out.sort((a,b) => new Date(b.timestamp).getTime()-new Date(a.timestamp).getTime())
  }, [tasks, pipelineEntries])

  const allTypes = useMemo(() => [...new Set(allEntries.map(e=>e.type))], [allEntries])
  const unreadCount = useMemo(() => allEntries.filter(e=>!readIds.has(e._id)).length, [allEntries, readIds])

  const filtered = useMemo(() => allEntries.filter(e => {
    if (filterModule !== 'all' && e._module !== filterModule) return false
    if (filterType !== 'all' && e.type !== filterType) return false
    if (filterActor !== 'all' && e.actor?.toLowerCase() !== filterActor.toLowerCase()) return false
    if (readFilter === 'unread' && readIds.has(e._id)) return false
    if (readFilter === 'read' && !readIds.has(e._id)) return false
    if (search && !e.message?.toLowerCase().includes(search.toLowerCase()) && !e._taskTitle?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [allEntries, filterModule, filterType, filterActor, readFilter, readIds, search])

  const grouped = useMemo(() => {
    const g: Record<string, LogEntry[]> = {}
    for (const e of filtered) {
      const day = new Date(e.timestamp).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })
      if (!g[day]) g[day] = []
      g[day].push(e)
    }
    return g
  }, [filtered])

  const markRead = (id: string) => setReadIds(prev => { const n=new Set([...prev,id]); saveReadIds(n); return n })
  const markAllRead = () => { const n=new Set(allEntries.map(e=>e._id)); saveReadIds(n); setReadIds(n) }

  const handleNavigate = (entry: LogEntry) => {
    markRead(entry._id)
    if (entry._module === 'projects') {
      const exists = tasks.find(t => t.id === entry._taskId)
      if (!exists) {
        setMissingTarget(`Card not found: ${entry._taskTitle}`)
        return
      }
      window.location.hash = 'projects'
      window.dispatchEvent(new CustomEvent('open-task', { detail: { id: entry._taskId } }))
      onClose?.()
      return
    }
    if (entry._module === 'pipeline') {
      window.location.hash = 'pipeline'
      onClose?.()
      return
    }
    if (entry._module === 'agents') {
      window.location.hash = 'agents'
      onClose?.()
      return
    }
    if (entry._module === 'docs') {
      window.location.hash = 'docs'
      onClose?.()
      return
    }
    if (entry._module === 'dashboard') {
      window.location.hash = 'dashboard'
      onClose?.()
    }
  }

  const selSx = {
    fontSize:'0.78rem', backgroundColor:'#1A1A23', borderRadius:2, color:'text.primary', height:34,
    '& .MuiOutlinedInput-notchedOutline':{borderColor:'rgba(255,255,255,0.1)'},
    '&:hover .MuiOutlinedInput-notchedOutline':{borderColor:'rgba(255,255,255,0.2)'},
    '& .MuiSelect-select':{py:0.6,px:1.25},
    '& .MuiSvgIcon-root':{color:'rgba(255,255,255,0.4)'},
  }

  return (
    <Box sx={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header */}
      <Box sx={{ px:3, pt:2.5, pb:2, borderBottom:'1px solid rgba(255,255,255,0.06)', flexShrink:0 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" mb={1.5}>
          <Box>
            <Typography variant="h6" fontWeight={700} color="text.primary">Activity Log</Typography>
            <Typography variant="caption" color="text.disabled">
              {MODULE_LABELS[filterModule] || filterModule} ·{' '}
              {filtered.length} events
              {unreadCount > 0 && <Box component="span" sx={{ color:'#FFA726', ml:0.5 }}>· {unreadCount} unread</Box>}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5}>
            {unreadCount > 0 && (
              <Tooltip title="Mark all read">
                <IconButton size="small" onClick={markAllRead} sx={{ color:'#A8C7FA', '&:hover':{backgroundColor:'rgba(168,199,250,0.08)'} }}>
                  <DoneAllRounded sx={{ fontSize:18 }} />
                </IconButton>
              </Tooltip>
            )}
            {onClose && (
              <IconButton size="small" onClick={onClose} sx={{ color:'text.disabled' }}>
                <CloseRounded sx={{ fontSize:18 }} />
              </IconButton>
            )}
          </Stack>
        </Stack>

        {/* Module tabs */}
        <Stack direction="row" spacing={0.75} mb={1.5} sx={{ overflowX:'auto', pb:0.5 }}>
          {['all','projects','docs','pipeline','agents'].map(m => (
            <Chip key={m} size="small" label={MODULE_LABELS[m]||m} onClick={() => { setFilterModule(m); setUserChangedModule(true) }}
              sx={{ height:26, fontSize:'0.72rem', borderRadius:2, cursor:'pointer', flexShrink:0,
                backgroundColor: filterModule===m ? (userChangedModule && m !== 'all' ? 'rgba(168,199,250,0.2)' : 'rgba(168,199,250,0.15)') : 'rgba(255,255,255,0.05)',
                color: filterModule===m ? '#A8C7FA' : 'text.disabled',
                border: filterModule===m ? `1px solid ${userChangedModule && m !== 'all' ? 'rgba(168,199,250,0.6)' : 'rgba(168,199,250,0.3)'}` : '1px solid transparent',
                fontWeight: filterModule===m && userChangedModule && m !== 'all' ? 700 : 400,
                transition:'all 0.15s',
              }} />
          ))}
        </Stack>

        {/* Filters */}
        <Stack direction="row" flexWrap="wrap" gap={1} alignItems="center">
          <TextField size="small" placeholder="Search..." value={search} onChange={e=>setSearch(e.target.value)}
            InputProps={{ startAdornment:<InputAdornment position="start"><SearchRounded sx={{fontSize:15,color:'text.disabled'}}/></InputAdornment> }}
            sx={{ flex:1, minWidth:120, '& .MuiOutlinedInput-root':{borderRadius:2,backgroundColor:'#1A1A23',fontSize:'0.78rem',height:34,'& fieldset':{borderColor:'rgba(255,255,255,0.1)'}} }} />

          <ToggleButtonGroup size="small" value={readFilter} exclusive onChange={(_,v)=>v&&setReadFilter(v)}
            sx={{ '& .MuiToggleButton-root':{height:34,borderColor:'rgba(255,255,255,0.1)',color:'text.disabled',fontSize:'0.7rem',px:1.25,textTransform:'none','&.Mui-selected':{backgroundColor:'rgba(168,199,250,0.1)',color:'#A8C7FA',borderColor:'rgba(168,199,250,0.3)'}} }}>
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="unread">Unread</ToggleButton>
            <ToggleButton value="read">Read</ToggleButton>
          </ToggleButtonGroup>

          <Select size="small" value={filterType} onChange={e=>setFilterType(e.target.value)} sx={selSx} displayEmpty>
            <MenuItem value="all" sx={{fontSize:'0.78rem'}}>All Types</MenuItem>
            {allTypes.map(t=><MenuItem key={t} value={t} sx={{fontSize:'0.78rem'}}>{TYPE_LABELS[t]||t}</MenuItem>)}
          </Select>

          <Select size="small" value={filterActor} onChange={e=>setFilterActor(e.target.value)} sx={selSx} displayEmpty>
            <MenuItem value="all" sx={{fontSize:'0.78rem'}}>All Users</MenuItem>
            {PEOPLE.map(p=><MenuItem key={p.id} value={p.name} sx={{fontSize:'0.78rem'}}>{p.name}</MenuItem>)}
          </Select>
        </Stack>
      </Box>

      {/* Log rows */}
      <Box sx={{ flex:1, overflow:'auto' }}>
        {Object.keys(grouped).length === 0 && (
          <Box sx={{ display:'flex', alignItems:'center', justifyContent:'center', height:'40%' }}>
            <Typography variant="body2" color="text.disabled">No events match your filters</Typography>
          </Box>
        )}
        {Object.entries(grouped).map(([day, entries]) => (
          <Box key={day}>
            <Box sx={{ px:3, py:1, backgroundColor:'rgba(255,255,255,0.015)', borderBottom:'1px solid rgba(255,255,255,0.04)', position:'sticky', top:0, backdropFilter:'blur(8px)', zIndex:1 }}>
              <Typography variant="overline" color="text.disabled" sx={{ fontSize:'0.6rem', letterSpacing:1.5 }}>{day}</Typography>
            </Box>
            {entries.map(entry => {
              const isRead = readIds.has(entry._id)
              return (
                <Box key={entry._id} onClick={() => handleNavigate(entry)} sx={{ display:'flex', alignItems:'center', gap:1.5, px:3, py:1.75, borderBottom:'1px solid rgba(255,255,255,0.04)', cursor:'pointer', backgroundColor:isRead?'transparent':'rgba(168,199,250,0.025)', transition:'background-color 0.15s', '&:hover':{backgroundColor:'rgba(255,255,255,0.02)'} }}>
                  {/* Unread dot */}
                  <Box sx={{ width:6, height:6, borderRadius:'50%', backgroundColor:isRead?'transparent':'#A8C7FA', flexShrink:0, transition:'background-color 0.2s' }} />
                  {/* Icon */}
                  <Box sx={{ width:28, height:28, borderRadius:'50%', backgroundColor:'rgba(255,255,255,0.05)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <TypeIcon type={entry.type} />
                  </Box>
                  {/* Content */}
                  <Box sx={{ flex:1, minWidth:0 }}>
                    <Stack direction="row" spacing={1} alignItems="center" mb={0.25} flexWrap="wrap">
                      <ActorBadge actor={entry.actor} />
                      <Typography variant="body2" color={isRead?'text.secondary':'text.primary'} sx={{ fontSize:'0.82rem', lineHeight:1.4 }}>
                        {entry.message}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" gap={0.5}>
                      <Typography variant="caption" color="text.disabled" sx={{ fontSize:'0.68rem' }}>{fmt(entry.timestamp)}</Typography>
                      <Chip size="small" label={TYPE_LABELS[entry.type]||entry.type}
                        sx={{ height:16, fontSize:'0.6rem', borderRadius:1, backgroundColor:(TYPE_COLORS[entry.type]||'#A8C7FA')+'18', color:TYPE_COLORS[entry.type]||'#A8C7FA', border:'none' }} />
                      <Typography variant="caption" sx={{ fontSize:'0.68rem', color:'rgba(255,255,255,0.3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:160 }}>
                        {entry._taskTitle}
                      </Typography>
                    </Stack>
                  </Box>
                  {/* Time */}
                  <Typography variant="caption" color="text.disabled" sx={{ fontSize:'0.68rem', flexShrink:0, display:{xs:'none',sm:'block'} }}>{fmt(entry.timestamp)}</Typography>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>

      <Snackbar open={!!missingTarget} autoHideDuration={4000} onClose={() => setMissingTarget(null)}>
        <Alert onClose={() => setMissingTarget(null)} severity="warning" variant="filled" sx={{ backgroundColor: '#5D4037' }}>
          {missingTarget}
        </Alert>
      </Snackbar>
    </Box>
  )
}
