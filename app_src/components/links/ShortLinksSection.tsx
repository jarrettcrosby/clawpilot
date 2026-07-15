'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import AddLinkRounded from '@mui/icons-material/AddLinkRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import ShortLinkFormDialog from './ShortLinkFormDialog'
import type { ShortLinkRecord, ShortLinkWriteInput } from './types'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'

type StatusKey = 'active' | 'disabled' | 'expired' | 'exhausted'

const fieldSx = {
  '& .MuiOutlinedInput-root': {
    borderRadius: '8px',
    backgroundColor: '#191921',
  },
}

const iconButtonSx = {
  width: 40,
  height: 40,
  flex: '0 0 40px',
  color: 'text.secondary',
  borderRadius: '8px',
  '&:hover': { color: '#A8C7FA', backgroundColor: 'rgba(168,199,250,0.08)' },
}

function payloadRecords(payload: unknown): ShortLinkRecord[] {
  if (Array.isArray(payload)) return payload as ShortLinkRecord[]
  if (!payload || typeof payload !== 'object') return []
  const object = payload as Record<string, unknown>
  const records = object.records ?? object.shortlinks ?? object.shortLinks ?? object.links ?? object.items
  return Array.isArray(records) ? records as ShortLinkRecord[] : []
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>
}

function errorMessage(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.error === 'string' && payload.error.trim() ? payload.error : fallback
}

function effectiveStatus(record: ShortLinkRecord): StatusKey {
  const raw = record.status.trim().toLowerCase()
  if (raw === 'disabled') return 'disabled'
  if (raw === 'expired' || (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) return 'expired'
  const remaining = record.remainingClicks == null && record.maxClicks != null
    ? Math.max(0, record.maxClicks - record.clickCount)
    : record.remainingClicks
  if (raw === 'exhausted' || remaining === 0) return 'exhausted'
  return 'active'
}

function statusPresentation(status: StatusKey) {
  if (status === 'active') return { label: 'Active', color: '#66BB6A', background: 'rgba(102,187,106,0.11)' }
  if (status === 'disabled') return { label: 'Disabled', color: '#B9B3C0', background: 'rgba(185,179,192,0.10)' }
  if (status === 'expired') return { label: 'Expired', color: '#FFA726', background: 'rgba(255,167,38,0.11)' }
  return { label: 'Limit reached', color: '#FFB4AB', background: 'rgba(255,180,171,0.11)' }
}

function formatRelativeDate(value: string | null): string {
  if (!value) return 'No expiry'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'Unknown expiry'
  const difference = timestamp - Date.now()
  const absolute = Math.abs(difference)
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [24 * 60 * 60 * 1000, 'day'],
    [60 * 60 * 1000, 'hour'],
    [60 * 1000, 'minute'],
  ]
  const [size, unit] = units.find(([candidate]) => absolute >= candidate) || units[2]
  const amount = difference < 0 ? Math.ceil(difference / size) : Math.floor(difference / size)
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit)
}

function formatDate(value: string, settings: UserDateTimeSettings) {
  return formatUserDateTime(value, settings, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    fallback: 'Unknown update time',
  })
}

function usage(record: ShortLinkRecord) {
  if (record.maxClicks == null) return { label: `${record.clickCount.toLocaleString()} clicks`, percent: null }
  const maxClicks = Math.max(1, record.maxClicks)
  return {
    label: `${record.clickCount.toLocaleString()} / ${record.maxClicks.toLocaleString()}`,
    percent: Math.min(100, Math.max(0, (record.clickCount / maxClicks) * 100)),
  }
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textArea = document.createElement('textarea')
  textArea.value = value
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  document.body.appendChild(textArea)
  textArea.select()
  document.execCommand('copy')
  textArea.remove()
}

export default function ShortLinksSection() {
  const dateTimeSettings = useUserDateTime()
  const shortLandscape = useMediaQuery('(orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)')
  const [records, setRecords] = useState<ShortLinkRecord[]>([])
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState({ search: '', tag: '' })
  const [refreshKey, setRefreshKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ShortLinkRecord | null>(null)
  const [deleting, setDeleting] = useState<ShortLinkRecord | null>(null)
  const [mutation, setMutation] = useState<string | null>(null)
  const [currentOwnerEmail, setCurrentOwnerEmail] = useState('')
  const [canManageOrganization, setCanManageOrganization] = useState(false)
  const requestSequence = useRef(0)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextSearch = search.trim()
      const nextTag = tag.trim()
      setQuery((current) => current.search === nextSearch && current.tag === nextTag
        ? current
        : { search: nextSearch, tag: nextTag })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search, tag])

  useEffect(() => {
    const controller = new AbortController()
    const sequence = requestSequence.current + 1
    requestSequence.current = sequence
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (query.search) params.set('q', query.search)
    if (query.tag) params.set('tag', query.tag)
    if (status) params.set('status', status)

    fetch(`/api/shortlinks${params.size ? `?${params.toString()}` : ''}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(errorMessage(payload as Record<string, unknown>, 'Unable to load short links'))
        if (sequence === requestSequence.current) {
          setRecords(payloadRecords(payload))
          const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
          setCurrentOwnerEmail(String(data.currentOwnerEmail || '').toLowerCase())
          setCanManageOrganization(data.canManageOrganization === true)
        }
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        if (sequence === requestSequence.current) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load short links')
        }
      })
      .finally(() => {
        if (sequence === requestSequence.current) setLoading(false)
      })

    return () => controller.abort()
  }, [query, refreshKey, status])

  const counts = useMemo(() => {
    const next = { active: 0, attention: 0 }
    for (const record of records) {
      if (effectiveStatus(record) === 'active') next.active += 1
      else next.attention += 1
    }
    return next
  }, [records])

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(record: ShortLinkRecord) {
    setEditing(record)
    setFormOpen(true)
  }

  async function saveLink(input: ShortLinkWriteInput) {
    const method = editing ? 'PATCH' : 'POST'
    const body = editing ? { id: editing.id, ...input } : input
    const key = `${method}:${editing?.id || 'new'}`
    setMutation(key)
    try {
      const response = await fetch('/api/shortlinks', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await responsePayload(response)
      if (!response.ok || payload.ok === false) throw new Error(errorMessage(payload, `Unable to ${editing ? 'update' : 'create'} short link`))
      setFormOpen(false)
      setEditing(null)
      setNotice(editing ? 'Short link updated' : 'Short link created')
      setRefreshKey((current) => current + 1)
    } finally {
      setMutation(null)
    }
  }

  async function toggleLink(record: ShortLinkRecord) {
    const currentStatus = effectiveStatus(record)
    if (currentStatus !== 'active' && currentStatus !== 'disabled') return
    const enable = currentStatus === 'disabled'
    const key = `toggle:${record.id}`
    setMutation(key)
    setError('')
    try {
      const response = await fetch('/api/shortlinks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: record.id, action: enable ? 'enable' : 'disable' }),
      })
      const payload = await responsePayload(response)
      if (!response.ok || payload.ok === false) throw new Error(errorMessage(payload, `Unable to ${enable ? 'enable' : 'disable'} short link`))
      setNotice(`Short link ${enable ? 'enabled' : 'disabled'}`)
      setRefreshKey((current) => current + 1)
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Unable to update short link')
    } finally {
      setMutation(null)
    }
  }

  async function deleteLink() {
    if (!deleting) return
    const record = deleting
    const key = `delete:${record.id}`
    setMutation(key)
    setError('')
    try {
      const response = await fetch(`/api/shortlinks?id=${encodeURIComponent(record.id)}`, { method: 'DELETE' })
      const payload = response.status === 204 ? {} : await responsePayload(response)
      if (!response.ok || payload.ok === false) throw new Error(errorMessage(payload, 'Unable to delete short link'))
      setDeleting(null)
      setNotice('Short link deleted')
      setRefreshKey((current) => current + 1)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete short link')
    } finally {
      setMutation(null)
    }
  }

  async function copyShortUrl(record: ShortLinkRecord) {
    try {
      await copyText(record.shortUrl)
      setNotice('Short URL copied')
    } catch {
      setError('Unable to copy short URL')
    }
  }

  return (
    <Box
      data-testid="short-links-section"
      sx={{ width: '100%', maxWidth: 1240, mx: 'auto', px: { xs: 2, sm: 3 }, py: { xs: 2.5, sm: 3.5 } }}
    >
      <Box display="flex" alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between" gap={2} mb={2.5}>
        <Box minWidth={0}>
          <Typography component="h1" variant="h5" fontWeight={700} color="text.primary">
            Short Links
          </Typography>
          <Typography variant="body2" color="text.secondary" mt={0.5}>
            {records.length} shown · {counts.active} active{counts.attention ? ` · ${counts.attention} attention` : ''}
          </Typography>
        </Box>
        <Button
          data-testid="create-short-link"
          variant="contained"
          startIcon={<AddLinkRounded />}
          onClick={openCreate}
          sx={{ minHeight: 40, borderRadius: '8px', px: 2, flexShrink: 0 }}
        >
          New link
        </Button>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr) minmax(0, 1fr) 40px', md: 'minmax(260px, 1fr) minmax(160px, 0.45fr) 150px 40px' },
          gap: 1.25,
          mb: 2,
          alignItems: 'center',
        }}
      >
        <TextField
          size="small"
          label="Search"
          placeholder="Destination, short URL, or slug"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          inputProps={{ 'aria-label': 'Search short links' }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
          sx={{ ...fieldSx, gridColumn: { xs: '1 / -1', md: 'auto' } }}
        />
        <TextField
          size="small"
          label="Tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          inputProps={{ 'aria-label': 'Filter by tag' }}
          sx={fieldSx}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          inputProps={{ 'aria-label': 'Filter by status' }}
          sx={fieldSx}
        >
          <MenuItem value="">All statuses</MenuItem>
          <MenuItem value="active">Active</MenuItem>
          <MenuItem value="disabled">Disabled</MenuItem>
          <MenuItem value="expired">Expired</MenuItem>
          <MenuItem value="exhausted">Limit reached</MenuItem>
        </TextField>
        <Tooltip title="Refresh short links">
          <span>
            <IconButton
              aria-label="Refresh short links"
              onClick={() => setRefreshKey((current) => current + 1)}
              disabled={loading}
              sx={{ ...iconButtonSx, justifySelf: 'end' }}
            >
              {loading ? <CircularProgress size={18} /> : <RefreshRounded />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}

      <Box
        data-testid="short-links-list"
        sx={{ borderTop: { lg: '1px solid rgba(255,255,255,0.09)' } }}
      >
        <Box
          sx={{
            display: { xs: 'none', lg: 'grid' },
            gridTemplateColumns: 'minmax(170px, 1.1fr) minmax(170px, 1fr) 96px 100px 110px 176px',
            gap: 1.25,
            alignItems: 'center',
            px: 1.5,
            py: 1,
            color: 'text.disabled',
          }}
        >
          {['Short link', 'Destination', 'Status', 'Usage', 'Expiry', 'Actions'].map((label) => (
            <Typography key={label} variant="caption" fontWeight={700}>{label}</Typography>
          ))}
        </Box>

        {loading && records.length === 0 ? (
          <Box display="grid" sx={{ minHeight: 280, placeItems: 'center' }}>
            <CircularProgress size={28} aria-label="Loading short links" />
          </Box>
        ) : null}

        {!loading && records.length === 0 ? (
          <Box display="grid" sx={{ minHeight: 280, placeItems: 'center', textAlign: 'center', px: 2 }}>
            <Box>
              <LinkOffRounded sx={{ fontSize: 42, color: 'rgba(255,255,255,0.16)', mb: 1 }} />
              <Typography variant="subtitle1" color="text.primary" fontWeight={700}>No short links found</Typography>
              <Typography variant="body2" color="text.secondary" mt={0.5}>Adjust the current filters or create a link.</Typography>
            </Box>
          </Box>
        ) : null}

        {records.map((record) => {
          const recordStatus = effectiveStatus(record)
          const statusView = statusPresentation(recordStatus)
          const recordUsage = usage(record)
          const recordBusy = mutation?.endsWith(`:${record.id}`) === true
          const canMutate = canManageOrganization || String(record.ownerEmail || '').toLowerCase() === currentOwnerEmail
          const terminal = recordStatus === 'expired' || recordStatus === 'exhausted'
          const enable = recordStatus === 'disabled'
          const toggleLabel = terminal
            ? recordStatus === 'expired' ? 'Edit expiry to reactivate' : 'Increase click cap to reactivate'
            : `${enable ? 'Enable' : 'Disable'} ${record.title || record.slug}`
          return (
            <Box
              key={record.id}
              data-testid={`short-link-${record.id}`}
              sx={{
                display: { xs: 'grid', lg: 'grid' },
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1.4fr) minmax(180px, 0.6fr)', lg: 'minmax(170px, 1.1fr) minmax(170px, 1fr) 96px 100px 110px 176px' },
                gap: { xs: 1.5, lg: 1.25 },
                alignItems: { lg: 'center' },
                px: { xs: 1.5, lg: 1.5 },
                py: { xs: 1.75, lg: 1.5 },
                mb: { xs: 1.25, lg: 0 },
                border: { xs: '1px solid rgba(255,255,255,0.09)', lg: 'none' },
                borderTop: { lg: '1px solid rgba(255,255,255,0.07)' },
                borderRadius: { xs: '8px', lg: 0 },
                backgroundColor: { xs: 'rgba(255,255,255,0.025)', lg: 'transparent' },
              }}
            >
              <Box minWidth={0}>
                <Box display="flex" alignItems="center" gap={1} minWidth={0}>
                  <Typography variant="body2" fontWeight={700} color="#A8C7FA" noWrap title={record.shortUrl}>
                    {record.shortUrl}
                  </Typography>
                  <Tooltip title="Copy short URL">
                    <IconButton
                      aria-label={`Copy ${record.title || record.slug}`}
                      size="small"
                      disabled={recordBusy}
                      onClick={() => void copyShortUrl(record)}
                      sx={{ color: 'text.secondary', width: 32, height: 32, borderRadius: '8px', flexShrink: 0 }}
                    >
                      <ContentCopyRounded sx={{ fontSize: 17 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
                <Typography variant="caption" color="text.secondary" noWrap display="block" title={record.title}>
                  {record.title || record.slug}
                </Typography>
                {record.tags.length ? (
                  <Box display="flex" flexWrap="wrap" gap={0.5} mt={0.75}>
                    {record.tags.slice(0, 3).map((recordTag) => (
                      <Chip
                        key={recordTag}
                        label={recordTag}
                        size="small"
                        onClick={() => setTag(recordTag)}
                        sx={{ minHeight: 22, height: 22, borderRadius: '6px', fontSize: '0.68rem', backgroundColor: 'rgba(168,199,250,0.08)', color: 'text.secondary' }}
                      />
                    ))}
                    {record.tags.length > 3 ? <Chip label={`+${record.tags.length - 3}`} size="small" sx={{ minHeight: 22, height: 22, borderRadius: '6px', fontSize: '0.68rem' }} /> : null}
                  </Box>
                ) : null}
              </Box>

              <Box minWidth={0}>
                <Typography variant="body2" color="text.primary" noWrap title={record.destinationUrl}>
                  {record.destinationUrl}
                </Typography>
                {record.ownerEmail || record.sourceApp ? (
                  <Typography variant="caption" color="text.secondary" display="block" noWrap title={record.ownerEmail}>
                    {[record.sourceApp, record.ownerEmail].filter(Boolean).join(' · ')}
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.disabled" display="block" mt={0.25}>
                  Updated {formatDate(record.updatedAt, dateTimeSettings)}
                </Typography>
              </Box>

              <Box>
                <Chip
                  label={statusView.label}
                  size="small"
                  sx={{ minHeight: 24, height: 24, borderRadius: '6px', fontSize: '0.7rem', fontWeight: 700, color: statusView.color, backgroundColor: statusView.background }}
                />
              </Box>

              <Box minWidth={0}>
                <Typography variant="body2" color="text.primary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{recordUsage.label}</Typography>
                {recordUsage.percent != null ? (
                  <LinearProgress
                    variant="determinate"
                    value={recordUsage.percent}
                    aria-label={`${recordUsage.label} click usage`}
                    sx={{ mt: 0.75, height: 3, borderRadius: '3px', backgroundColor: 'rgba(255,255,255,0.08)', '& .MuiLinearProgress-bar': { backgroundColor: recordUsage.percent >= 100 ? '#FFB4AB' : '#A8C7FA' } }}
                  />
                ) : null}
              </Box>

              <Box>
                <Typography variant="body2" color={recordStatus === 'expired' ? '#FFA726' : 'text.primary'}>
                  {formatRelativeDate(record.expiresAt)}
                </Typography>
              </Box>

              <Box display="flex" alignItems="center" justifyContent={{ xs: 'flex-end', sm: 'flex-start', lg: 'flex-end' }} gap={0.25}>
                <Tooltip title="Open short link">
                  <IconButton
                    component="a"
                    href={record.shortUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${record.title || record.slug}`}
                    sx={iconButtonSx}
                  >
                    <OpenInNewRounded sx={{ fontSize: 20 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Edit short link">
                  <IconButton aria-label={`Edit ${record.title || record.slug}`} onClick={() => openEdit(record)} disabled={recordBusy || !canMutate} sx={iconButtonSx}>
                    <EditRounded sx={{ fontSize: 20 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title={toggleLabel}>
                  <span style={{ display: 'inline-flex' }}>
                    <IconButton aria-label={toggleLabel} onClick={() => void toggleLink(record)} disabled={recordBusy || terminal || !canMutate} sx={iconButtonSx}>
                      {recordBusy && mutation?.startsWith('toggle:')
                        ? <CircularProgress size={18} />
                        : enable ? <CheckCircleOutlineRounded sx={{ fontSize: 20 }} /> : <BlockRounded sx={{ fontSize: 20 }} />}
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="Delete short link">
                  <IconButton
                    aria-label={`Delete ${record.title || record.slug}`}
                    onClick={() => setDeleting(record)}
                    disabled={recordBusy || !canMutate}
                    sx={{ ...iconButtonSx, '&:hover': { color: '#FFB4AB', backgroundColor: 'rgba(255,180,171,0.08)' } }}
                  >
                    <DeleteOutlineRounded sx={{ fontSize: 20 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          )
        })}
      </Box>

      <ShortLinkFormDialog
        open={formOpen}
        record={editing}
        busy={mutation?.startsWith('POST:') === true || mutation?.startsWith('PATCH:') === true}
        onClose={() => { if (!mutation) setFormOpen(false) }}
        onSubmit={saveLink}
      />

      <Dialog
        open={Boolean(deleting)}
        onClose={() => { if (!mutation) setDeleting(null) }}
        fullScreen={shortLandscape}
        aria-labelledby="delete-short-link-title"
        PaperProps={{ sx: { width: shortLandscape ? '100%' : 'min(92vw, 440px)', borderRadius: shortLandscape ? 0 : '8px', border: '1px solid rgba(255,255,255,0.09)', backgroundColor: '#1A1A23' } }}
      >
        <DialogTitle id="delete-short-link-title" sx={{ fontSize: '1.05rem', fontWeight: 700 }}>Delete short link?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {deleting?.shortUrl}
          </Typography>
        </DialogContent>
        <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)' }} />
        <DialogActions sx={{ px: 2.5, py: 2 }}>
          <Button onClick={() => setDeleting(null)} disabled={Boolean(mutation)} sx={{ minHeight: 38, borderRadius: '8px' }}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void deleteLink()}
            disabled={Boolean(mutation)}
            startIcon={mutation?.startsWith('delete:') ? <CircularProgress size={16} color="inherit" /> : <DeleteOutlineRounded />}
            sx={{ minHeight: 38, borderRadius: '8px' }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={3000}
        onClose={() => setNotice('')}
        message={notice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  )
}
