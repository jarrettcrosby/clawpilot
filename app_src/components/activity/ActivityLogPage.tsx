'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Snackbar from '@mui/material/Snackbar'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AccessTimeRounded from '@mui/icons-material/AccessTimeRounded'
import AddCircleOutlineRounded from '@mui/icons-material/AddCircleOutlineRounded'
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import DoneAllRounded from '@mui/icons-material/DoneAllRounded'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlined from '@mui/icons-material/InfoOutlined'
import LoginRounded from '@mui/icons-material/LoginRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import SyncRounded from '@mui/icons-material/SyncRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { queueProjectTaskOpen } from '@/lib/projects/navigation'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'

const READ_KEY = 'clawpilot_read_log'

type ActivityScope = 'self' | 'organization' | 'global'
type ActivityEvent = {
  id: string
  module: string
  type: string
  eventType: string
  message: string
  timestamp: string
  actor: string
  actorName: string | null
  target: {
    section: 'projects' | 'pipeline' | 'crm' | 'agents' | 'docs' | 'versions'
    id?: string
    resourceId?: string
    label?: string
  } | null
  details: Record<string, unknown>
}

type ActivityPayload = {
  ok?: boolean
  error?: string
  events?: ActivityEvent[]
  nextCursor?: string | null
  scope?: ActivityScope
  capabilities?: {
    canViewOrganization: boolean
    canViewGlobal: boolean
    defaultScope: ActivityScope
  }
}

type Props = { onClose?: () => void }

const MODULE_LABELS: Record<string, string> = {
  all: 'All',
  auth: 'Access',
  projects: 'Projects',
  pipeline: 'Pipeline',
  crm: 'CRM',
  agents: 'Agents',
  docs: 'Docs',
  users: 'People',
  integrations: 'Integrations',
  versions: 'Versions',
  system: 'System',
}

const TYPE_COLORS: Record<string, string> = {
  failed: '#EF5350',
  deleted: '#EF5350',
  succeeded: '#66BB6A',
  created: '#66BB6A',
  queued: '#FFA726',
  moved: '#A8C7FA',
  comment: '#FFA726',
  updated: '#78909C',
}

function getReadIds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]')) } catch { return new Set() }
}

function saveReadIds(ids: Set<string>) {
  try { localStorage.setItem(READ_KEY, JSON.stringify([...ids].slice(-5000))) } catch {}
}

function activityTargetUrl(target: NonNullable<ActivityEvent['target']>) {
  const url = new URL(window.location.href)
  for (const parameter of ['board', 'pipeline', 'crm', 'crmAction', 'doc']) url.searchParams.delete(parameter)
  if (target.resourceId && target.section === 'projects') url.searchParams.set('board', target.resourceId)
  if (target.resourceId && (target.section === 'pipeline' || target.section === 'crm')) {
    url.searchParams.set('pipeline', target.resourceId)
  }
  if (target.id && target.section === 'crm') url.searchParams.set('crm', target.id)
  if (target.id && target.section === 'docs') url.searchParams.set('doc', target.id)
  url.hash = target.section
  return url
}

function navigateToTarget(target: NonNullable<ActivityEvent['target']>) {
  const oldURL = window.location.href
  const nextUrl = activityTargetUrl(target)
  window.history.pushState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`)
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: nextUrl.toString() }))
}

function displayType(type: string) {
  return type.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function TypeIcon({ event }: { event: ActivityEvent }) {
  const color = TYPE_COLORS[event.type] || 'rgba(255,255,255,0.45)'
  const sx = { fontSize: 16, color }
  if (event.module === 'auth') return <LoginRounded sx={sx} />
  if (event.type === 'failed') return <ErrorOutlineRounded sx={sx} />
  if (event.type === 'succeeded') return <CheckCircleOutlineRounded sx={sx} />
  if (event.type === 'deleted') return <DeleteOutlineRounded sx={sx} />
  if (event.type === 'created') return <AddCircleOutlineRounded sx={sx} />
  if (event.type === 'queued') return <SyncRounded sx={sx} />
  return <AccessTimeRounded sx={sx} />
}

function ActorBadge({ event }: { event: ActivityEvent }) {
  const name = event.actorName || event.actor || 'System'
  const initials = name === 'system'
    ? 'SY'
    : name.split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'CP'
  const color = event.actor === 'system' ? '#78909C' : '#A8C7FA'
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
      <Box sx={{ width: 22, height: 22, borderRadius: '50%', backgroundColor: `${color}22`, border: `1px solid ${color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Typography sx={{ color, fontWeight: 700, fontSize: '0.58rem', lineHeight: 1 }}>{initials}</Typography>
      </Box>
      <Typography variant="caption" sx={{ color, fontWeight: 600, fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</Typography>
    </Stack>
  )
}

function formatTimestamp(iso: string, settings: UserDateTimeSettings) {
  return formatUserDateTime(iso, settings, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown date',
  })
}

function detailValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not set'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function searchableDetailText(details: Record<string, unknown>): string {
  return Object.entries(details)
    .flatMap(([key, value]) => [displayType(key), detailValue(value)])
    .join(' ')
}

function crmRecordMetadata(event: ActivityEvent): { recordType: string | null; referenceCode: string | null } | null {
  if (event.module !== 'crm') return null
  const recordType = typeof event.details.recordType === 'string' && event.details.recordType.trim()
    ? event.details.recordType.trim()
    : null
  const detailReference = [event.details.referenceCode, event.details.globalId]
    .find((value) => typeof value === 'string' && value.trim())
  const referenceCode = typeof detailReference === 'string'
    ? detailReference.trim()
    : event.target?.id || null
  return { recordType, referenceCode }
}

export default function ActivityLogPage({ onClose }: Props) {
  const dateTimeSettings = useUserDateTime()
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [scope, setScope] = useState<ActivityScope | null>(null)
  const [capabilities, setCapabilities] = useState<ActivityPayload['capabilities']>(undefined)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [readIds, setReadIds] = useState<Set<string>>(() => getReadIds())
  const [search, setSearch] = useState('')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [actorFilter, setActorFilter] = useState('all')
  const [readFilter, setReadFilter] = useState<'all' | 'unread' | 'read'>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [navigationError, setNavigationError] = useState<string | null>(null)

  const load = useCallback(async (requestedScope: ActivityScope | null, cursor: string | null = null, append = false) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (requestedScope) params.set('scope', requestedScope)
      if (cursor) params.set('cursor', cursor)
      const response = await fetch(`/api/activity?${params.toString()}`, { cache: 'no-store' })
      const payload = await response.json().catch(() => ({})) as ActivityPayload
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to load activity')
      const nextEvents = Array.isArray(payload.events) ? payload.events : []
      setEvents((current) => append ? [...current, ...nextEvents] : nextEvents)
      setNextCursor(typeof payload.nextCursor === 'string' ? payload.nextCursor : null)
      setCapabilities(payload.capabilities)
      if (payload.scope && payload.scope !== requestedScope) setScope(payload.scope)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load activity')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  const modules = useMemo(() => ['all', ...Array.from(new Set(events.map((event) => event.module))).sort()], [events])
  const types = useMemo(() => Array.from(new Set(events.map((event) => event.type))).sort(), [events])
  const actors = useMemo(() => {
    const unique = new Map<string, string>()
    for (const event of events) unique.set(event.actor, event.actorName || event.actor)
    return [...unique.entries()].sort((left, right) => left[1].localeCompare(right[1]))
  }, [events])
  const unreadCount = useMemo(() => events.filter((event) => !readIds.has(event.id)).length, [events, readIds])

  const filtered = useMemo(() => {
    const searchTerm = search.trim().toLowerCase()
    return events.filter((event) => {
      if (moduleFilter !== 'all' && event.module !== moduleFilter) return false
      if (typeFilter !== 'all' && event.type !== typeFilter) return false
      if (actorFilter !== 'all' && event.actor !== actorFilter) return false
      if (readFilter === 'unread' && readIds.has(event.id)) return false
      if (readFilter === 'read' && !readIds.has(event.id)) return false
      if (searchTerm) {
        const haystack = [
          event.message,
          event.eventType,
          event.actor,
          event.actorName,
          event.target?.label,
          event.target?.id,
          event.target?.resourceId,
          searchableDetailText(event.details),
        ].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(searchTerm)) return false
      }
      return true
    })
  }, [actorFilter, events, moduleFilter, readFilter, readIds, search, typeFilter])

  const grouped = useMemo(() => {
    const result: Record<string, ActivityEvent[]> = {}
    for (const event of filtered) {
      const day = formatUserDateTime(event.timestamp, dateTimeSettings, {
        weekday: 'long', month: 'long', day: 'numeric', fallback: 'Unknown date',
      })
      if (!result[day]) result[day] = []
      result[day].push(event)
    }
    return result
  }, [dateTimeSettings, filtered])

  function markRead(id: string) {
    setReadIds((current) => {
      const next = new Set(current).add(id)
      saveReadIds(next)
      return next
    })
  }

  function markAllRead() {
    const next = new Set([...readIds, ...events.map((event) => event.id)])
    saveReadIds(next)
    setReadIds(next)
  }

  function toggleDetails(id: string) {
    markRead(id)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function changeScope(nextScope: ActivityScope) {
    setModuleFilter('all')
    setTypeFilter('all')
    setActorFilter('all')
    setExpanded(new Set())
    setScope(nextScope)
  }

  async function selectResource(target: NonNullable<ActivityEvent['target']>) {
    if (!target.resourceId || !['projects', 'pipeline', 'crm'].includes(target.section)) return
    const kind = target.section === 'projects' ? 'board' : 'pipeline'
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: `select-${kind}`, [`${kind}Id`]: target.resourceId }),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(payload.error || `Unable to open ${kind}`)
    }
  }

  async function navigate(event: ActivityEvent) {
    markRead(event.id)
    if (!event.target) {
      toggleDetails(event.id)
      return
    }
    try {
      await selectResource(event.target)
      if (event.target.section === 'projects' && event.target.id) queueProjectTaskOpen(event.target.id)
      if (event.target.resourceId && ['projects', 'pipeline', 'crm'].includes(event.target.section)) {
        const nextUrl = activityTargetUrl(event.target)
        onClose?.()
        window.location.assign(nextUrl.toString())
        return
      }
      navigateToTarget(event.target)
      onClose?.()
    } catch (navigationFailure) {
      setNavigationError(navigationFailure instanceof Error ? navigationFailure.message : 'Unable to open activity target')
    }
  }

  const selectSx = {
    fontSize: '0.78rem', backgroundColor: '#1A1A23', borderRadius: 1, color: 'text.primary', height: 34,
    '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.1)' },
    '& .MuiSelect-select': { py: 0.6, px: 1.25 },
    '& .MuiSvgIcon-root': { color: 'rgba(255,255,255,0.4)' },
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, sm: 3 }, pt: 2.5, pb: 2, borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" mb={1.5}>
          <Box>
            <Typography variant="h6" fontWeight={700}>Activity</Typography>
            <Typography variant="caption" color="text.disabled">
              {filtered.length} events{unreadCount > 0 ? ` · ${unreadCount} unread` : ''}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5}>
            {unreadCount > 0 && (
              <Tooltip title="Mark all read">
                <IconButton size="small" onClick={markAllRead} sx={{ color: '#A8C7FA' }}><DoneAllRounded sx={{ fontSize: 18 }} /></IconButton>
              </Tooltip>
            )}
            {onClose && <IconButton size="small" onClick={onClose} aria-label="Close activity"><CloseRounded sx={{ fontSize: 18 }} /></IconButton>}
          </Stack>
        </Stack>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={scope || ''}
          onChange={(_, value: ActivityScope | null) => value && changeScope(value)}
          sx={{ mb: 1.5, maxWidth: '100%', overflowX: 'auto', '& .MuiToggleButton-root': { minHeight: 34, px: 1.5, color: 'text.disabled', textTransform: 'none', whiteSpace: 'nowrap', borderColor: 'rgba(255,255,255,0.1)', '&.Mui-selected': { color: '#A8C7FA', backgroundColor: 'rgba(168,199,250,0.1)' } } }}
        >
          <ToggleButton value="self">My activity</ToggleButton>
          {capabilities?.canViewOrganization && <ToggleButton value="organization">Organization</ToggleButton>}
          {capabilities?.canViewGlobal && <ToggleButton value="global">Global system</ToggleButton>}
        </ToggleButtonGroup>

        <Stack direction="row" spacing={0.75} mb={1.5} sx={{ overflowX: 'auto', pb: 0.5 }}>
          {modules.map((module) => (
            <Chip
              key={module}
              size="small"
              label={MODULE_LABELS[module] || displayType(module)}
              onClick={() => setModuleFilter(module)}
              sx={{ height: 26, fontSize: '0.72rem', borderRadius: 1, flexShrink: 0, cursor: 'pointer', backgroundColor: moduleFilter === module ? 'rgba(168,199,250,0.15)' : 'rgba(255,255,255,0.05)', color: moduleFilter === module ? '#A8C7FA' : 'text.disabled', border: moduleFilter === module ? '1px solid rgba(168,199,250,0.3)' : '1px solid transparent' }}
            />
          ))}
        </Stack>

        <Stack direction="row" flexWrap="wrap" gap={1} alignItems="center">
          <TextField
            size="small"
            placeholder="Search activity"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 16, color: 'text.disabled' }} /></InputAdornment> }}
            sx={{ flex: 1, minWidth: { xs: '100%', sm: 160 }, '& .MuiOutlinedInput-root': { borderRadius: 1, backgroundColor: '#1A1A23', fontSize: '0.78rem', height: 34, '& fieldset': { borderColor: 'rgba(255,255,255,0.1)' } } }}
          />
          <ToggleButtonGroup size="small" value={readFilter} exclusive onChange={(_, value) => value && setReadFilter(value)} sx={{ '& .MuiToggleButton-root': { height: 34, borderColor: 'rgba(255,255,255,0.1)', color: 'text.disabled', fontSize: '0.7rem', px: 1.1, textTransform: 'none', '&.Mui-selected': { backgroundColor: 'rgba(168,199,250,0.1)', color: '#A8C7FA' } } }}>
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="unread">Unread</ToggleButton>
            <ToggleButton value="read">Read</ToggleButton>
          </ToggleButtonGroup>
          <Select size="small" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} sx={selectSx}>
            <MenuItem value="all" sx={{ fontSize: '0.78rem' }}>All types</MenuItem>
            {types.map((type) => <MenuItem key={type} value={type} sx={{ fontSize: '0.78rem' }}>{displayType(type)}</MenuItem>)}
          </Select>
          <Select size="small" value={actorFilter} onChange={(event) => setActorFilter(event.target.value)} sx={selectSx}>
            <MenuItem value="all" sx={{ fontSize: '0.78rem' }}>All users</MenuItem>
            {actors.map(([email, name]) => <MenuItem key={email} value={email} sx={{ fontSize: '0.78rem' }}>{name}</MenuItem>)}
          </Select>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {loading && <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 220 }}><CircularProgress size={28} /></Box>}
        {!loading && error && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
        {!loading && !error && Object.keys(grouped).length === 0 && (
          <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 220 }}><Typography variant="body2" color="text.disabled">No events match the filters</Typography></Box>
        )}
        {!loading && !error && Object.entries(grouped).map(([day, dayEvents]) => (
          <Box key={day}>
            <Box sx={{ px: { xs: 2, sm: 3 }, py: 1, backgroundColor: 'rgba(255,255,255,0.015)', borderBottom: '1px solid rgba(255,255,255,0.04)', position: 'sticky', top: 0, backdropFilter: 'blur(8px)', zIndex: 1 }}>
              <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.6rem', letterSpacing: 1.5 }}>{day}</Typography>
            </Box>
            {dayEvents.map((event) => {
              const isRead = readIds.has(event.id)
              const isExpanded = expanded.has(event.id)
              const color = TYPE_COLORS[event.type] || '#A8C7FA'
              const crmMetadata = crmRecordMetadata(event)
              return (
                <Box key={event.id} sx={{ borderBottom: '1px solid rgba(255,255,255,0.04)', backgroundColor: isRead ? 'transparent' : 'rgba(168,199,250,0.025)' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: { xs: 2, sm: 3 }, py: 1.5 }}>
                    <Box sx={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: isRead ? 'transparent' : '#A8C7FA', flexShrink: 0 }} />
                    <Box sx={{ width: 30, height: 30, borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><TypeIcon event={event} /></Box>
                    <Box onClick={() => void navigate(event)} sx={{ flex: 1, minWidth: 0, cursor: event.target ? 'pointer' : 'default' }}>
                      <Stack direction="row" spacing={1} alignItems="center" mb={0.35} flexWrap="wrap">
                        <ActorBadge event={event} />
                        <Typography variant="body2" color={isRead ? 'text.secondary' : 'text.primary'} sx={{ fontSize: '0.82rem', lineHeight: 1.4 }}>{event.message}</Typography>
                      </Stack>
                      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                        <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.68rem' }}>{formatTimestamp(event.timestamp, dateTimeSettings)}</Typography>
                        <Chip size="small" label={displayType(event.type)} sx={{ height: 17, fontSize: '0.6rem', borderRadius: 0.75, backgroundColor: `${color}18`, color }} />
                        {crmMetadata?.recordType && (
                          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem' }}>
                            <Box component="span" sx={{ color: 'text.disabled' }}>Record type:</Box> {crmMetadata.recordType}
                          </Typography>
                        )}
                        {crmMetadata?.referenceCode && (
                          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem', overflowWrap: 'anywhere' }}>
                            <Box component="span" sx={{ color: 'text.disabled' }}>Global ID:</Box>{' '}
                            <Box component="span" sx={{ fontFamily: 'monospace' }}>{crmMetadata.referenceCode}</Box>
                          </Typography>
                        )}
                        <Typography variant="caption" sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: { xs: 150, sm: 260 } }}>{event.target?.label || event.eventType}</Typography>
                      </Stack>
                    </Box>
                    {event.target && (
                      <Tooltip title="Open target"><IconButton size="small" onClick={() => void navigate(event)} aria-label="Open activity target"><OpenInNewRounded sx={{ fontSize: 17 }} /></IconButton></Tooltip>
                    )}
                    <Tooltip title="Event details"><IconButton size="small" onClick={() => toggleDetails(event.id)} aria-label="Show event details" color={isExpanded ? 'primary' : 'default'}><InfoOutlined sx={{ fontSize: 18 }} /></IconButton></Tooltip>
                  </Box>
                  <Collapse in={isExpanded} unmountOnExit>
                    <Box sx={{ px: { xs: 2, sm: 3 }, pb: 1.75, pl: { xs: 7.5, sm: 9.5 } }}>
                      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: 'minmax(90px, auto) minmax(0, 1fr)', sm: '140px minmax(0, 1fr)' }, columnGap: 1.5, rowGap: 0.5 }}>
                        {Object.entries(event.details).map(([key, value]) => (
                          <Box key={key} sx={{ display: 'contents' }}>
                            <Typography component="dt" variant="caption" color="text.disabled" sx={{ m: 0 }}>{displayType(key)}</Typography>
                            <Typography component="dd" variant="caption" color="text.secondary" sx={{ m: 0, overflowWrap: 'anywhere' }}>{detailValue(value)}</Typography>
                          </Box>
                        ))}
                      </Box>
                    </Box>
                  </Collapse>
                </Box>
              )
            })}
          </Box>
        ))}
        {!loading && !error && nextCursor !== null && (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
            <Button variant="outlined" size="small" disabled={loadingMore} onClick={() => void load(scope, nextCursor, true)}>{loadingMore ? 'Loading' : 'Load more'}</Button>
          </Box>
        )}
      </Box>

      <Snackbar open={Boolean(navigationError)} autoHideDuration={4000} onClose={() => setNavigationError(null)}>
        <Alert onClose={() => setNavigationError(null)} severity="warning" variant="filled">{navigationError}</Alert>
      </Snackbar>
    </Box>
  )
}
