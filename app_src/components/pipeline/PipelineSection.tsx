'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Skeleton from '@mui/material/Skeleton'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import Divider from '@mui/material/Divider'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import TextField from '@mui/material/TextField'
import MenuItem from '@mui/material/MenuItem'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import InputAdornment from '@mui/material/InputAdornment'
import Autocomplete from '@mui/material/Autocomplete'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ViewColumnRounded from '@mui/icons-material/ViewColumnRounded'
import TableRowsRounded from '@mui/icons-material/TableRowsRounded'
import CallRounded from '@mui/icons-material/CallRounded'
import EmailRounded from '@mui/icons-material/EmailRounded'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import useMediaQuery from '@mui/material/useMediaQuery'

type Contact = {
  id: string
  name: string
  phone?: string
  email?: string
  title?: string
}

type SyncSurface = {
  state: 'unknown' | 'syncing' | 'ok' | 'error'
  lastSyncedAt: string | null
  summary?: { opportunities?: number; organizations?: number; contacts?: number; totalOpenValue?: number } | null
  error?: string
  feedback?: string
}

type Deal = {
  id: string
  priority: string
  name: string
  owner: string
  org: string
  status: string
  stage: string
  lossReason: string
  source: string
  value: number
  valueRaw: string
  probability: number
  closeDate: string
  notes: string
  updatedAt?: string
  contacts?: Contact[]
  contactName?: string
  contactPhone?: string
  contactEmail?: string
  contactTitle?: string
}

function normalizeDeal(d: Deal): Deal {
  return {
    ...d,
    value: Math.round(Number(d.value || 0)),
    probability: Math.round(Number(d.probability || 0) * 10) / 10,
  }
}

const DEFAULT_STAGES = ['Identified Lead', 'Qualified Lead', 'Needs Analysis', 'Demo', 'Proposal', 'Neogotiation', 'Loss', 'Won']
const DEFAULT_PRIORITIES = ['A+', 'A', 'B', 'C', 'D']
const DEFAULT_STATUSES = ['Open', 'Abandoned', 'Closed', 'Won', 'Lost']
const DEFAULT_SOURCES = ['Inbound', 'Outbound', 'Referral', 'Website', 'Partner']
const DEFAULT_OWNERS = ['Jarrett Crosby']
const DEFAULT_LOSS_REASONS = ['No Decision', 'Budget', 'Competition', 'Not a Fit']
const DEFAULT_PRODUCTS = ['CAO']

const PRIORITY_COLORS: Record<string, string> = {
  'A+': '#66BB6A', A: '#A8C7FA', B: '#CFC6EA', C: '#FDD663', D: '#EF5350',
}

function fmt$(n: number) {
  if (!n) return '—'
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function fmtPct(n: number) {
  return `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function fmtSyncTime(iso: string | null) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Unknown'
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true })
}

function fmtIntInput(n: number) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function toInputDate(value: string | undefined) {
  const v = String(value || '').trim()
  if (!v) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v)
  if (m) {
    const mm = m[1].padStart(2, '0')
    const dd = m[2].padStart(2, '0')
    const yyyy = m[3]
    return `${yyyy}-${mm}-${dd}`
  }
  return ''
}

function fromInputDate(value: string | undefined) {
  const v = String(value || '').trim()
  if (!v) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return v
  const yyyy = Number(m[1])
  const mm = Number(m[2])
  const dd = Number(m[3])
  return `${mm}/${dd}/${yyyy}`
}

function normalizePhone(phone: unknown) {
  const raw = String(phone || '').trim()
  if (!raw) return ''
  const digits = raw.replace(/[^\d+]/g, '')
  return digits || raw
}

function normalizeEmail(email: unknown) {
  const raw = String(email || '').trim()
  if (!raw) return ''
  return raw
}

function contactFromLooseShape(input: any, fallbackId: string): Contact | null {
  if (!input || typeof input !== 'object') return null

  const name = String(input.name || input.fullName || input.contactName || '').trim()
  const phone = normalizePhone(input.phone || input.mobile || input.cell || input.contactPhone)
  const email = normalizeEmail(input.email || input.contactEmail)
  const title = String(input.title || input.role || '').trim()

  if (!name && !phone && !email) return null

  return {
    id: String(input.id || fallbackId),
    name: name || 'Unnamed Contact',
    phone: phone || undefined,
    email: email || undefined,
    title: title || undefined,
  }
}

function getAssociatedContacts(deal: Deal | null): Contact[] {
  if (!deal) return []

  const contacts: Contact[] = []

  if (Array.isArray(deal.contacts)) {
    deal.contacts.forEach((c, idx) => {
      const mapped = contactFromLooseShape(c, `contacts-${idx}`)
      if (mapped) contacts.push(mapped)
    })
  }

  const fallbackSingle = contactFromLooseShape({
    name: deal.contactName,
    phone: deal.contactPhone,
    email: deal.contactEmail,
    title: deal.contactTitle,
  }, 'primary')

  if (fallbackSingle) {
    const dup = contacts.some(c => c.name === fallbackSingle.name && c.phone === fallbackSingle.phone && c.email === fallbackSingle.email)
    if (!dup) contacts.push(fallbackSingle)
  }

  return contacts
}

function contactActionScore(contact: Contact) {
  let score = 0
  if (contact.phone) score += 2
  if (contact.email) score += 2
  if (contact.title) score += 1
  return score
}

function normalizeContactsForActionability(contacts: Contact[]) {
  return [...contacts].sort((a, b) => contactActionScore(b) - contactActionScore(a))
}

function DealCard({ deal, onClick, onMoveStage }: { deal: Deal; onClick: () => void; onMoveStage: (deal: Deal, direction: -1 | 1) => void }) {
  const pColor = PRIORITY_COLORS[deal.priority] || '#78909C'
  return (
    <Box
      onClick={onClick}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); onMoveStage(deal, -1) }
        if (e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); onMoveStage(deal, 1) }
        if (e.key === 'Enter') { e.preventDefault(); onClick() }
      }}
      sx={{ backgroundColor: '#1A1A23', borderRadius: 2, p: 2, border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', '&:hover': { borderColor: 'rgba(168,199,250,0.25)' }, '&:focus-visible': { outline: '2px solid rgba(168,199,250,0.55)', outlineOffset: 2 }, mb: 1.25 }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" mb={0.75}>
        <Box sx={{ flex: 1, minWidth: 0, mr: 1 }}>
          <Typography variant="body2" fontWeight={700} color="text.primary" sx={{ fontSize: '0.82rem' }}>{deal.org || 'Unknown Organization'}</Typography>
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.7rem' }}>{deal.name || '—'}</Typography>
        </Box>
        <Chip size="small" label={deal.priority || '—'} sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700, borderRadius: 1, backgroundColor: pColor + '22', color: pColor, border: `1px solid ${pColor}44` }} />
      </Stack>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="caption" sx={{ color: '#66BB6A', fontWeight: 700, fontSize: '0.78rem' }}>{fmt$(deal.value)}</Typography>
        {deal.probability > 0 && <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.68rem' }}>{fmtPct(deal.probability)}</Typography>}
      </Stack>
    </Box>
  )
}

function DealDrawer({
  deal,
  onClose,
  onSave,
  onComment,
  priorities,
  statuses,
  stages,
  sources,
  owners,
  lossReasons,
  products,
}: {
  deal: Deal | null
  onClose: () => void
  onSave: (d: Deal) => Promise<void>
  onComment: (id: string, comment: string) => Promise<void>
  priorities: string[]
  statuses: string[]
  stages: string[]
  sources: string[]
  owners: string[]
  lossReasons: string[]
  products: string[]
}) {
  const [form, setForm] = useState<Deal | null>(null)
  const [saving, setSaving] = useState(false)
  const [comment, setComment] = useState('')
  const [error, setError] = useState('')
  const closeDateRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setForm(deal ? normalizeDeal(deal) : null)
    setComment('')
    setError('')
  }, [deal])

  const touchLandscape = useMediaQuery('(orientation: landscape) and (pointer: coarse)')

  if (!form) return null

  const associatedContacts = normalizeContactsForActionability(getAssociatedContacts(form))

  return (
    <Drawer anchor="right" open={!!deal} onClose={onClose} PaperProps={{ sx: { width: touchLandscape ? { xs: '96vw', sm: 600 } : { xs: '100vw', sm: 520 }, maxWidth: '100vw', height: '100dvh', backgroundColor: '#0F0F13', borderLeft: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' } }}>
      <Box sx={{ px: 3, py: 2, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="h6" fontWeight={700}>{form.org || 'Unknown Organization'}</Typography>
            <Typography variant="caption" color="text.disabled">{form.name || '—'}</Typography>
          </Box>
          <IconButton size="small" onClick={onClose}><CloseRounded /></IconButton>
        </Stack>
      </Box>

      <Box sx={{ px: { xs: 2, sm: 3 }, py: 2, pb: 'calc(env(safe-area-inset-bottom) + 20px)', minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Stack spacing={1.5}>
          <Autocomplete
            multiple
            freeSolo
            options={products}
            value={(form.name || '').split(',').map(s => s.trim()).filter(Boolean)}
            onChange={(_, values) => setForm({ ...form, name: (values || []).map(v => String(v).trim()).filter(Boolean).join(', ') })}
            renderTags={(value: readonly string[], getTagProps) =>
              value.map((option: string, index: number) => (
                <Chip variant="outlined" size="small" label={option} {...getTagProps({ index })} key={`${option}-${index}`} />
              ))
            }
            renderInput={(params) => <TextField {...params} label="Product" size="small" placeholder="Type to search/select" />}
          />
          <TextField label="Priority" select size="small" value={form.priority || ''} onChange={e => setForm({ ...form, priority: e.target.value })}>
            {priorities.map(p => <MenuItem key={p} value={p}>{p}</MenuItem>)}
          </TextField>
          <TextField label="Status" select size="small" value={form.status || ''} onChange={e => setForm({ ...form, status: e.target.value })}>
            {statuses.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </TextField>
          <TextField label="Stage" select size="small" value={form.stage || ''} onChange={e => setForm({ ...form, stage: e.target.value })}>
            {stages.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </TextField>
          <TextField label="Owner" select size="small" value={form.owner || ''} onChange={e => setForm({ ...form, owner: e.target.value })}>
            {owners.map(o => <MenuItem key={o} value={o}>{o}</MenuItem>)}
          </TextField>
          <TextField
            label="Expected Close"
            size="small"
            type="date"
            value={form.closeDate || ''}
            onChange={e => setForm({ ...form, closeDate: e.target.value })}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: {
                ref: closeDateRef,
                onClick: () => {
                  const el = closeDateRef.current
                  if (!el) return
                  // @ts-ignore
                  if (typeof el.showPicker === 'function') {
                    // @ts-ignore
                    el.showPicker()
                  }
                },
              },
            }}
            sx={{
              '& input::-webkit-calendar-picker-indicator': {
                filter: 'invert(78%) sepia(12%) saturate(512%) hue-rotate(186deg) brightness(90%) contrast(89%)',
                opacity: 0.9,
                cursor: 'pointer',
              },
              '& input[type="date"]': {
                colorScheme: 'dark',
              },
            }}
          />
          <TextField
            label="Value"
            size="small"
            type="text"
            value={fmtIntInput(form.value || 0)}
            onChange={e => {
              const raw = String(e.target.value || '').replace(/[^0-9.-]/g, '')
              const n = Math.round(Number(raw || 0))
              setForm({ ...form, value: Number.isFinite(n) ? n : 0 })
            }}
            slotProps={{ input: { startAdornment: <InputAdornment position="start">$</InputAdornment> } }}
          />
          <TextField
            label="Probability"
            size="small"
            type="text"
            value={Number(form.probability || 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            onChange={e => {
              const raw = String(e.target.value || '').replace(/[^0-9.-]/g, '')
              const n = Number(raw || 0)
              const rounded = Math.round(n * 10) / 10
              setForm({ ...form, probability: Number.isFinite(rounded) ? rounded : 0 })
            }}
            slotProps={{ input: { endAdornment: <InputAdornment position="end">%</InputAdornment> } }}
          />
          <TextField label="Source" select size="small" value={form.source || ''} onChange={e => setForm({ ...form, source: e.target.value })}>
            {sources.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </TextField>
          <TextField label="Loss Reason" select size="small" value={form.lossReason || ''} onChange={e => setForm({ ...form, lossReason: e.target.value })}>
            {lossReasons.map(l => <MenuItem key={l} value={l}>{l}</MenuItem>)}
          </TextField>
        </Stack>

        <Stack direction="row" spacing={1} mt={2}>
          <Button variant="contained" disabled={saving} onClick={async () => {
            try {
              setSaving(true)
              setError('')
              await onSave(form)
            } catch (e: any) {
              setError(String(e?.message || e))
            } finally {
              setSaving(false)
            }
          }}>Save to Sheet</Button>
        </Stack>

        <Divider sx={{ my: 2, borderColor: 'rgba(255,255,255,0.08)' }} />

        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
          <Typography variant="subtitle2">Associated Contacts</Typography>
          {associatedContacts.length > 0 && (
            <Chip
              size="small"
              label={`${associatedContacts.filter(c => c.phone || c.email).length}/${associatedContacts.length} actionable`}
              sx={{ height: 22, fontSize: '0.68rem', backgroundColor: 'rgba(168,199,250,0.12)', color: '#A8C7FA' }}
            />
          )}
        </Stack>
        {associatedContacts.length === 0 ? (
          <Typography variant="body2" color="text.disabled">No associated contacts on this opportunity yet.</Typography>
        ) : (
          <Stack spacing={1.25}>
            {associatedContacts.map((contact, idx) => {
              const hasPhone = !!contact.phone
              const hasEmail = !!contact.email
              const actionable = hasPhone || hasEmail
              const isPrimary = idx === 0

              return (
                <Box key={contact.id} sx={{ p: 1.25, borderRadius: 2, border: isPrimary ? '1px solid rgba(168,199,250,0.45)' : '1px solid rgba(255,255,255,0.08)', backgroundColor: isPrimary ? 'rgba(168,199,250,0.08)' : 'rgba(255,255,255,0.02)' }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                    <Typography variant="body2" fontWeight={600}>{contact.name}</Typography>
                    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                      {isPrimary && <Chip size="small" label="Primary" sx={{ height: 20, fontSize: '0.62rem', backgroundColor: 'rgba(168,199,250,0.18)', color: '#A8C7FA' }} />}
                      <Chip
                        size="small"
                        label={actionable ? 'Actionable' : 'Needs method'}
                        sx={{
                          height: 20,
                          fontSize: '0.62rem',
                          backgroundColor: actionable ? 'rgba(102,187,106,0.16)' : 'rgba(255,167,38,0.16)',
                          color: actionable ? '#66BB6A' : '#FFA726',
                        }}
                      />
                    </Stack>
                  </Stack>

                  {contact.title && (
                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.75 }}>{contact.title}</Typography>
                  )}

                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Button
                      component={hasPhone ? 'a' : 'button'}
                      href={hasPhone ? `tel:${contact.phone}` : undefined}
                      variant="outlined"
                      size="small"
                      startIcon={<CallRounded sx={{ fontSize: 16 }} />}
                      disabled={!hasPhone}
                      sx={{ minHeight: 40 }}
                    >
                      {hasPhone ? 'Call' : 'No phone'}
                    </Button>
                    <Button
                      component={hasEmail ? 'a' : 'button'}
                      href={hasEmail ? `mailto:${contact.email}` : undefined}
                      variant="outlined"
                      size="small"
                      startIcon={<EmailRounded sx={{ fontSize: 16 }} />}
                      disabled={!hasEmail}
                      sx={{ minHeight: 40 }}
                    >
                      {hasEmail ? 'Email' : 'No email'}
                    </Button>
                  </Stack>

                  <Stack spacing={0.25} mt={0.75}>
                    {hasPhone && <Typography variant="caption" color="text.secondary">{contact.phone}</Typography>}
                    {hasEmail && <Typography variant="caption" color="text.secondary">{contact.email}</Typography>}
                    {!actionable && (
                      <Typography variant="caption" color="warning.main">Add phone or email to make this contact actionable.</Typography>
                    )}
                  </Stack>
                </Box>
              )
            })}
          </Stack>
        )}

        <Divider sx={{ my: 2, borderColor: 'rgba(255,255,255,0.08)' }} />

        <Typography variant="subtitle2" mb={1}>Add Comment (appends to Notes)</Typography>
        <TextField multiline minRows={3} fullWidth value={comment} onChange={e => setComment(e.target.value)} placeholder="Write a comment..." />
        <Stack direction="row" spacing={1} mt={1}>
          <Button variant="outlined" disabled={saving || !comment.trim()} onClick={async () => {
            try {
              setSaving(true)
              setError('')
              await onComment(form.id, comment)
              setComment('')
            } catch (e: any) {
              setError(String(e?.message || e))
            } finally {
              setSaving(false)
            }
          }}>Append to Notes</Button>
        </Stack>

        {form.notes && (
          <>
            <Divider sx={{ my: 2, borderColor: 'rgba(255,255,255,0.08)' }} />
            <Typography variant="caption" color="text.disabled">Current Notes</Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 1, color: 'text.secondary' }}>{form.notes}</Typography>
          </>
        )}
      </Box>
    </Drawer>
  )
}

export default function PipelineSection() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<'board' | 'list'>('board')
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'closed'>('all')
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null)
  const [stageOptions, setStageOptions] = useState<string[]>(DEFAULT_STAGES)
  const [priorityOptions, setPriorityOptions] = useState<string[]>(DEFAULT_PRIORITIES)
  const [statusOptions, setStatusOptions] = useState<string[]>(DEFAULT_STATUSES)
  const [sourceOptions, setSourceOptions] = useState<string[]>(DEFAULT_SOURCES)
  const [ownerOptions, setOwnerOptions] = useState<string[]>(DEFAULT_OWNERS)
  const [lossReasonOptions, setLossReasonOptions] = useState<string[]>(DEFAULT_LOSS_REASONS)
  const [productOptions, setProductOptions] = useState<string[]>(DEFAULT_PRODUCTS)
  const touchLandscape = useMediaQuery('(orientation: landscape) and (pointer: coarse)')
  const tabletOrSmaller = useMediaQuery('(max-width: 1024px)')
  const compactLandscapeBoard = touchLandscape && tabletOrSmaller
  const [activeStage, setActiveStage] = useState<string>(DEFAULT_STAGES[0])
  const [syncSurface, setSyncSurface] = useState<SyncSurface>({ state: 'unknown', lastSyncedAt: null, summary: null })
  const [syncingNow, setSyncingNow] = useState(false)

  const load = async () => {
    const data = await fetch('/api/pipeline').then(r => r.json())
    const rows = Array.isArray(data) ? data : (Array.isArray(data.opportunities) ? data.opportunities : [])
    const mapped: Deal[] = rows.map((r: any, i: number) => ({
      id: String(r.id ?? i),
      priority: r.priority || '',
      name: r.name || '',
      owner: r.owner || '',
      org: r.org || r.organization || '',
      status: r.status || '',
      stage: r.stage || '',
      lossReason: r.lossReason || '',
      source: r.source || '',
      value: Math.round(Number(r.value || 0)),
      valueRaw: r.valueRaw || '',
      probability: Math.round(Number(r.probability || 0) * 10) / 10,
      closeDate: toInputDate(r.closeDate || r.expectedClose || ''),
      notes: r.notes || '',
      updatedAt: r.updatedAt,
      contacts: Array.isArray(r.contacts) ? r.contacts : undefined,
      contactName: r.contactName || r.primaryContactName || '',
      contactPhone: r.contactPhone || r.primaryContactPhone || '',
      contactEmail: r.contactEmail || r.primaryContactEmail || '',
      contactTitle: r.contactTitle || r.primaryContactTitle || '',
    }))
    setDeals(mapped)
  }

  const loadSyncStatus = async () => {
    try {
      const res = await fetch('/api/pipeline/sync-status')
      const out = await res.json()
      if (!res.ok || out?.ok === false) {
        setSyncSurface({
          state: 'error',
          lastSyncedAt: out?.syncedAt || null,
          summary: out?.summary || null,
          error: String(out?.error || `sync-status failed (${res.status})`),
        })
        return
      }

      setSyncSurface({
        state: 'ok',
        lastSyncedAt: out?.syncedAt || null,
        summary: out?.summary || null,
        feedback: undefined,
      })
    } catch (e: any) {
      setSyncSurface({
        state: 'error',
        lastSyncedAt: null,
        summary: null,
        error: String(e?.message || e),
      })
    }
  }

  const runManualSync = async () => {
    if (syncingNow) return

    setSyncingNow(true)
    setSyncSurface((prev) => ({ ...prev, state: 'syncing', error: undefined, feedback: 'Manual sync in progress…' }))

    try {
      const res = await fetch('/api/pipeline/sync/pull', { method: 'POST' })
      const out = await res.json()
      if (!res.ok || out?.ok === false) {
        setSyncSurface((prev) => ({
          ...prev,
          state: 'error',
          error: String(out?.error || `manual sync failed (${res.status})`),
          feedback: 'Manual sync failed. Current pipeline data was preserved.',
        }))
        return
      }

      await Promise.all([load(), loadSyncStatus()])
      setSyncSurface((prev) => ({
        ...prev,
        state: 'ok',
        error: undefined,
        feedback: 'Manual sync completed successfully. Pipeline data was refreshed.',
      }))
    } catch (e: any) {
      setSyncSurface((prev) => ({
        ...prev,
        state: 'error',
        error: String(e?.message || e),
        feedback: 'Manual sync failed. Current pipeline data was preserved.',
      }))
    } finally {
      setSyncingNow(false)
    }
  }

  const loadDropdowns = async () => {
    const out = await fetch('/api/pipeline/dropdowns').then(r => r.json())
    const dropdowns = out?.catalog?.dropdowns || {}
    const pick = (key: string, fallback: string[]) => {
      const items = Array.isArray(dropdowns?.[key]) ? dropdowns[key] : []
      const active = items.filter((x: any) => x?.active !== false)
      const values = active
        .sort((a: any, b: any) => Number(a?.sort_order || 0) - Number(b?.sort_order || 0))
        .map((x: any) => String(x?.label || x?.value || '').trim())
        .filter(Boolean)
      return values.length ? values : fallback
    }

    setStageOptions(pick('stage', DEFAULT_STAGES))
    setPriorityOptions(pick('priority', DEFAULT_PRIORITIES))
    setStatusOptions(pick('status', DEFAULT_STATUSES))
    setSourceOptions(pick('source', DEFAULT_SOURCES))
    setOwnerOptions(pick('owner', DEFAULT_OWNERS))
    setLossReasonOptions(pick('loss_reason', DEFAULT_LOSS_REASONS))
    setProductOptions(pick('product', DEFAULT_PRODUCTS))
  }

  useEffect(() => {
    let done = false
    const failsafe = setTimeout(() => {
      if (!done) setLoading(false)
    }, 12000)

    Promise.all([load(), loadDropdowns(), loadSyncStatus()])
      .then(() => { done = true; setLoading(false) })
      .catch(e => { done = true; setError(String(e)); setLoading(false) })
      .finally(() => clearTimeout(failsafe))

    return () => clearTimeout(failsafe)
  }, [])

  useEffect(() => {
    if (!stageOptions.length) return
    if (!stageOptions.includes(activeStage)) setActiveStage(stageOptions[0])
  }, [stageOptions, activeStage])

  const filtered = useMemo(() => {
    if (filterStatus === 'open') return deals.filter(d => (d.status || '').toLowerCase() === 'open')
    if (filterStatus === 'closed') return deals.filter(d => (d.status || '').toLowerCase() !== 'open')
    return deals
  }, [deals, filterStatus])

  const openDeals = useMemo(() => deals.filter(d => (d.status || '').toLowerCase() === 'open'), [deals])
  const closedDeals = useMemo(() => deals.filter(d => (d.status || '').toLowerCase() !== 'open'), [deals])
  const totalValue = useMemo(() => openDeals.reduce((s, d) => s + d.value, 0), [openDeals])

  const moveDealStage = async (deal: Deal, direction: -1 | 1) => {
    const idx = stageOptions.findIndex(s => s === deal.stage)
    if (idx < 0) return
    const nextIdx = idx + direction
    if (nextIdx < 0 || nextIdx >= stageOptions.length) return
    const nextStage = stageOptions[nextIdx]

    const res = await fetch(`/api/pipeline/opportunity/${deal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: deal.updatedAt, stage: nextStage }),
    })
    const out = await res.json()
    if (!res.ok) return
    setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, stage: nextStage, updatedAt: out?.opportunity?.updatedAt || d.updatedAt } : d))
  }

  const patchOpportunityWithRetry = async (deal: Deal, body: Record<string, unknown>) => {
    let localDeal = { ...deal }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`/api/pipeline/opportunity/${localDeal.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, expectedUpdatedAt: localDeal.updatedAt }),
        })
        const out = await res.json()

        if (res.status === 409 && attempt === 0) {
          // Refresh latest and retry once with newest updatedAt
          const snap = await fetch('/api/pipeline').then(r => r.json())
          const rows = Array.isArray(snap) ? snap : (Array.isArray(snap?.opportunities) ? snap.opportunities : [])
          const latest = rows.find((r: any) => r?.id === localDeal.id)
          if (latest?.updatedAt) {
            localDeal = { ...localDeal, updatedAt: latest.updatedAt }
            continue
          }
        }

        if (!res.ok) throw new Error(out?.error || `Save failed (${res.status})`)
        return out
      } catch (e: any) {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 250))
          continue
        }
        throw new Error(`Network/save error: ${String(e?.message || e)}`)
      }
    }
    throw new Error('Save failed after retry')
  }

  if (loading) return <Box sx={{ p: 3 }}>{[1, 2, 3].map(i => <Skeleton key={i} variant="rounded" height={80} sx={{ mb: 2 }} />)}</Box>
  if (error) return <Box sx={{ p: 3 }}><Alert severity="error">{error}</Alert></Box>

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" gap={1.25}>
          <Box><Typography variant="caption" color="text.disabled">Pipeline Value</Typography><Typography variant="h6" fontWeight={700} color="#66BB6A">{fmt$(totalValue)}</Typography></Box>
          <Box><Typography variant="caption" color="text.disabled">Open</Typography><Typography variant="h6" fontWeight={700}>{openDeals.length}</Typography></Box>
          <Box><Typography variant="caption" color="text.disabled">Closed</Typography><Typography variant="h6" fontWeight={700}>{closedDeals.length}</Typography></Box>

          <Stack spacing={0.45} sx={{ minWidth: { xs: '100%', sm: 260 }, maxWidth: { xs: '100%', md: 460 } }}>
            <Typography variant="caption" sx={{ color: '#A8C7FA', fontWeight: 700 }}>Pipeline Sync (Manual V1)</Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="caption" color="text.disabled">Sync status</Typography>
              <Chip
                size="small"
                label={syncSurface.state === 'syncing' ? 'Syncing…' : syncSurface.state === 'ok' ? 'In sync' : syncSurface.state === 'error' ? 'Sync error' : 'Unknown'}
                sx={{
                  height: 20,
                  fontSize: '0.65rem',
                  backgroundColor: syncSurface.state === 'ok'
                    ? 'rgba(102,187,106,0.18)'
                    : syncSurface.state === 'error'
                      ? 'rgba(239,83,80,0.18)'
                      : syncSurface.state === 'syncing'
                        ? 'rgba(168,199,250,0.18)'
                        : 'rgba(255,255,255,0.08)',
                  color: syncSurface.state === 'ok' ? '#66BB6A' : syncSurface.state === 'error' ? '#EF5350' : syncSurface.state === 'syncing' ? '#A8C7FA' : 'text.secondary',
                }}
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">Last synced timestamp: {fmtSyncTime(syncSurface.lastSyncedAt)}</Typography>
            {syncSurface.feedback && (
              <Typography
                variant="caption"
                color={syncSurface.state === 'error' ? 'error.main' : syncSurface.state === 'ok' ? 'success.main' : 'text.secondary'}
              >
                {syncSurface.feedback}
              </Typography>
            )}
            {syncSurface.state === 'error' && syncSurface.error && (
              <Typography variant="caption" color="error.main">{syncSurface.error}</Typography>
            )}
            {syncSurface.state === 'error' && (
              <Typography variant="caption" sx={{ color: '#FFA726', fontWeight: 600 }}>
                Retry: click “Sync now” to pull fresh sheet data manually.
              </Typography>
            )}
          </Stack>

          <Box sx={{ flex: 1 }} />
          <Stack direction="row" spacing={1} sx={{ width: { xs: '100%', sm: 'auto' }, justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}>
            <Button
              variant={syncSurface.state === 'error' ? 'contained' : 'outlined'}
              color={syncSurface.state === 'error' ? 'warning' : 'primary'}
              size="small"
              onClick={runManualSync}
              disabled={syncingNow}
              sx={{ minHeight: 38, minWidth: 112 }}
            >
              {syncingNow ? 'Syncing…' : syncSurface.state === 'error' ? 'Retry sync now' : 'Sync now'}
            </Button>
            <ToggleButtonGroup size="small" value={filterStatus} exclusive onChange={(_, v) => v && setFilterStatus(v)}>
              <ToggleButton value="all">All</ToggleButton>
              <ToggleButton value="open">Open</ToggleButton>
              <ToggleButton value="closed">Closed</ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup size="small" value={view} exclusive onChange={(_, v) => v && setView(v)}>
              <Tooltip title="Board view"><ToggleButton value="board"><ViewColumnRounded sx={{ fontSize: 18 }} /></ToggleButton></Tooltip>
              <Tooltip title="List view"><ToggleButton value="list"><TableRowsRounded sx={{ fontSize: 18 }} /></ToggleButton></Tooltip>
            </ToggleButtonGroup>
          </Stack>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, overflow: 'auto', px: { xs: 1, md: 2 }, py: 2 }}>
        {view === 'board' ? (
          compactLandscapeBoard ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
              <Tabs
                value={activeStage}
                onChange={(_, v) => setActiveStage(String(v))}
                variant="scrollable"
                allowScrollButtonsMobile
                sx={{
                  minHeight: 38,
                  mb: 1,
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  '& .MuiTab-root': { minHeight: 38, textTransform: 'none', fontSize: '0.76rem', color: 'text.secondary' },
                  '& .Mui-selected': { color: '#A8C7FA' },
                  '& .MuiTabs-indicator': { backgroundColor: '#A8C7FA' },
                }}
              >
                {stageOptions.map(stage => (
                  <Tab key={stage} value={stage} label={`${stage} (${filtered.filter(d => d.stage === stage).length})`} />
                ))}
              </Tabs>

              <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch', pr: 0.5 }}>
                {(filtered.filter(d => d.stage === activeStage)).map(deal => (
                  <DealCard key={deal.id} deal={deal} onClick={() => setSelectedDeal(deal)} onMoveStage={moveDealStage} />
                ))}
                {filtered.filter(d => d.stage === activeStage).length === 0 && (
                  <Typography variant="body2" color="text.disabled" sx={{ px: 1.5, py: 2 }}>No opportunities in this stage.</Typography>
                )}
              </Box>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', gap: 2, height: '100%', alignItems: 'flex-start', overflowX: 'auto', pb: 2, WebkitOverflowScrolling: 'touch', touchAction: 'pan-x' }}>
              {stageOptions.map(stage => {
                const stageDeals = filtered.filter(d => d.stage === stage)
                return (
                  <Box key={stage} sx={{ minWidth: 220, maxWidth: 240, flexShrink: 0 }}>
                    <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.25} px={0.5}>
                      <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem' }}>{stage}</Typography>
                      <Chip size="small" label={stageDeals.length} sx={{ height: 18, fontSize: '0.62rem', borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.06)' }} />
                    </Stack>
                    {stageDeals.map(deal => <DealCard key={deal.id} deal={deal} onClick={() => setSelectedDeal(deal)} onMoveStage={moveDealStage} />)}
                  </Box>
                )
              })}
            </Box>
          )
        ) : (
          <Box>
            {filtered.map(deal => (
              <Box key={deal.id} onClick={() => setSelectedDeal(deal)} sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1.5, minHeight: 48, borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={600}>{deal.org || 'Unknown Organization'}</Typography>
                  <Typography variant="caption" color="text.disabled">{deal.name || '—'}</Typography>
                </Box>
                <Typography variant="caption" sx={{ color: '#66BB6A', fontWeight: 700 }}>{fmt$(deal.value)}</Typography>
                <Chip size="small" label={deal.stage || '—'} />
              </Box>
            ))}
          </Box>
        )}
      </Box>

      <DealDrawer
        deal={selectedDeal}
        onClose={() => setSelectedDeal(null)}
        priorities={priorityOptions}
        statuses={statusOptions}
        stages={stageOptions}
        sources={sourceOptions}
        owners={ownerOptions}
        lossReasons={lossReasonOptions}
        products={productOptions}
        onSave={async (deal) => {
          const out = await patchOpportunityWithRetry(deal, {
            priority: deal.priority,
            status: deal.status,
            stage: deal.stage,
            owner: deal.owner,
            closeDate: fromInputDate(deal.closeDate),
            value: Math.round(Number(deal.value || 0)),
            probability: Math.round(Number(deal.probability || 0) * 10) / 10,
            source: deal.source,
            lossReason: deal.lossReason,
          })
          await load()
          setSelectedDeal(out.opportunity ? { ...out.opportunity, closeDate: toInputDate(out.opportunity.closeDate || out.opportunity.expectedClose || '') } : null)
        }}
        onComment={async (id, comment) => {
          const res = await fetch(`/api/pipeline/opportunity/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appendComment: comment, actor: 'Jarrett', expectedUpdatedAt: selectedDeal?.updatedAt }),
          })
          const out = await res.json()
          if (!res.ok) throw new Error(out?.error || 'comment failed')
          await load()
          setSelectedDeal(out.opportunity ? { ...out.opportunity, closeDate: toInputDate(out.opportunity.closeDate || out.opportunity.expectedClose || '') } : null)
        }}
      />
    </Box>
  )
}
