'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Skeleton from '@mui/material/Skeleton'
import CircularProgress from '@mui/material/CircularProgress'
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
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import InputAdornment from '@mui/material/InputAdornment'
import Autocomplete from '@mui/material/Autocomplete'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ViewColumnRounded from '@mui/icons-material/ViewColumnRounded'
import TableRowsRounded from '@mui/icons-material/TableRowsRounded'
import CallRounded from '@mui/icons-material/CallRounded'
import EmailRounded from '@mui/icons-material/EmailRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import AddToDriveRounded from '@mui/icons-material/AddToDriveRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import TuneRounded from '@mui/icons-material/TuneRounded'
import InsightsRounded from '@mui/icons-material/InsightsRounded'
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import useMediaQuery from '@mui/material/useMediaQuery'
import WorkspaceSelector from '@/components/workspaces/WorkspaceSelector'
import PipelineInsights from '@/components/pipeline/PipelineInsights'
import PipelineCatalogDialog, {
  type PipelineCatalogPerson,
  type PipelineCatalogProduct,
  type PipelineCatalogSnapshot,
} from '@/components/pipeline/PipelineCatalogDialog'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'
import { isActivePipelineStatus, summarizePipeline } from '@/lib/pipeline/analytics.mjs'
import { BASE_PIPELINE_WORKFLOW } from '@/lib/pipeline/baseTemplate.mjs'

type Contact = {
  id: string
  name: string
  organizationId?: string
  referenceCode?: string
  phone?: string
  email?: string
  title?: string
}

type SyncSurface = {
  state: 'unknown' | 'syncing' | 'ok' | 'error'
  lastSyncedAt: string | null
  summary?: {
    opportunities?: number
    organizations?: number
    contacts?: number
    totalOpenValue?: number
    weightedPipelineValue?: number
    pendingSync?: number
    failedSync?: number
  } | null
  error?: string
  feedback?: string
}

type Deal = {
  id: string
  organizationId?: string
  contactIds?: string[]
  productIds?: string[]
  ownerContactId?: string
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

type PipelineSummary = {
  activeCount: number
  wonCount: number
  activeValue: number
  weightedActiveValue: number
  active: Deal[]
}

type LooseRecord = Record<string, unknown>
type DropdownOption = { active?: boolean; sort_order?: number; label?: string; value?: string }
type PipelineProvisioningStatus = 'not_requested' | 'queued' | 'provisioning' | 'ready' | 'failed'
type OrganizationOption = {
  id: string
  name: string
  referenceCode: string
  email: string
  phone: string
  relationshipType: string
}

const EMPTY_OPPORTUNITY = {
  organizationId: '',
  contactIds: [] as string[],
  productIds: [] as string[],
  ownerContactId: '',
  priority: 'C',
  stage: 'Identified Lead',
  value: '',
  probability: '',
  expectedClose: '',
  notes: '',
}

function pipelineMutationKey() {
  return globalThis.crypto?.randomUUID?.() || `pipeline-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
type DateInputWithPicker = HTMLInputElement & { showPicker?: () => void }

function normalizeDeal(d: Deal): Deal {
  return {
    ...d,
    value: Math.round(Number(d.value || 0)),
    probability: Math.round(Number(d.probability || 0) * 10) / 10,
  }
}

const DEFAULT_STAGES = [...BASE_PIPELINE_WORKFLOW.stage]
const DEFAULT_PRIORITIES = [...BASE_PIPELINE_WORKFLOW.priority]
const DEFAULT_STATUSES = [...BASE_PIPELINE_WORKFLOW.status]
const DEFAULT_SOURCES = [...BASE_PIPELINE_WORKFLOW.source]
const DEFAULT_LOSS_REASONS = [...BASE_PIPELINE_WORKFLOW.loss_reason]

const PRIORITY_COLORS: Record<string, string> = {
  'A+': '#66BB6A', A: '#A8C7FA', B: '#CFC6EA', C: '#FDD663', D: '#EF5350',
}

const PRIORITY_SORT_WEIGHT: Record<string, number> = {
  'A+': 5,
  A: 4,
  B: 3,
  C: 2,
  D: 1,
}

function fmt$(n: number) {
  if (!n) return '—'
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function compareDealsForPriority(a: Deal, b: Deal) {
  const aActive = isActivePipelineStatus(a.status) ? 1 : 0
  const bActive = isActivePipelineStatus(b.status) ? 1 : 0
  if (aActive !== bActive) return bActive - aActive

  const aPriority = PRIORITY_SORT_WEIGHT[(a.priority || '').trim()] || 0
  const bPriority = PRIORITY_SORT_WEIGHT[(b.priority || '').trim()] || 0
  if (aPriority !== bPriority) return bPriority - aPriority

  const aValue = Number(a.value || 0)
  const bValue = Number(b.value || 0)
  if (aValue !== bValue) return bValue - aValue

  const aUpdated = new Date(a.updatedAt || 0).getTime()
  const bUpdated = new Date(b.updatedAt || 0).getTime()
  if (aUpdated !== bUpdated) return bUpdated - aUpdated

  return String(a.org || '').localeCompare(String(b.org || ''))
}

function fmtPct(n: number) {
  return `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function fmtSyncTime(iso: string | null, settings: UserDateTimeSettings) {
  if (!iso) return 'Never'
  return formatUserDateTime(iso, settings, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown',
  })
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

function contactFromLooseShape(input: unknown, fallbackId: string): Contact | null {
  if (!input || typeof input !== 'object') return null
  const record = input as LooseRecord

  const name = String(record.name || record.fullName || record.contactName || '').trim()
  const phone = normalizePhone(record.phone || record.mobile || record.cell || record.contactPhone)
  const email = normalizeEmail(record.email || record.contactEmail)
  const title = String(record.title || record.role || '').trim()

  if (!name && !phone && !email) return null

  return {
    id: String(record.id || fallbackId),
    organizationId: String(record.organizationId || '') || undefined,
    referenceCode: String(record.referenceCode || '') || undefined,
    name: name || 'Unnamed Contact',
    phone: phone || undefined,
    email: email || undefined,
    title: title || undefined,
  }
}

function dealFromLooseShape(row: LooseRecord, index = 0): Deal {
  return {
    id: String(row.id ?? index),
    organizationId: String(row.organizationId || '') || undefined,
    contactIds: Array.isArray(row.contactIds) ? row.contactIds.map(String) : [],
    productIds: Array.isArray(row.productIds) ? row.productIds.map(String) : [],
    ownerContactId: String(row.ownerContactId || '') || undefined,
    priority: String(row.priority || ''),
    name: String(row.name || ''),
    owner: String(row.owner || ''),
    org: String(row.org || row.organization || ''),
    status: String(row.status || ''),
    stage: String(row.stage || ''),
    lossReason: String(row.lossReason || ''),
    source: String(row.source || ''),
    value: Math.round(Number(row.value || 0)),
    valueRaw: String(row.valueRaw || ''),
    probability: Math.round(Number(row.probability || 0) * 10) / 10,
    closeDate: toInputDate(String(row.closeDate || row.expectedClose || '')),
    notes: String(row.notes || ''),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : undefined,
    contacts: Array.isArray(row.contacts)
      ? row.contacts.map((contact, contactIndex) => contactFromLooseShape(contact, `contact-${contactIndex}`)).filter((contact): contact is Contact => Boolean(contact))
      : undefined,
    contactName: String(row.contactName || row.primaryContactName || ''),
    contactPhone: String(row.contactPhone || row.primaryContactPhone || ''),
    contactEmail: String(row.contactEmail || row.primaryContactEmail || ''),
    contactTitle: String(row.contactTitle || row.primaryContactTitle || ''),
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

function normalizeContactsForActionability(contacts: Contact[]) {
  // Relationship order is meaningful: the first selected contact is primary.
  return [...contacts]
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
  contactOptions,
  readOnly,
}: {
  deal: Deal | null
  onClose: () => void
  onSave: (d: Deal) => Promise<void>
  onComment: (id: string, comment: string) => Promise<void>
  priorities: string[]
  statuses: string[]
  stages: string[]
  sources: string[]
  owners: PipelineCatalogPerson[]
  lossReasons: string[]
  products: PipelineCatalogProduct[]
  contactOptions: Contact[]
  readOnly?: boolean
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
  const legacyProductNames = (form.name || '').split(',').map((value) => value.trim()).filter(Boolean)
  const selectableProducts = products.filter((product) => product.active)
  const selectedProducts = products.filter((product) => (form.productIds || []).includes(product.id))
  const selectedProductNames = new Set(selectedProducts.map((product) => product.name.trim().toLowerCase()))
  const displayedProducts = [
    ...selectedProducts,
    ...legacyProductNames.filter((name) => !selectedProductNames.has(name.toLowerCase())).map((name, index) => ({
        id: `legacy-${index}-${name}`,
        referenceCode: '',
        name,
        sku: '',
        productType: '',
        category: '',
        status: 'Legacy',
        price: 0,
        cost: 0,
        currency: 'USD',
        url: '',
        description: '',
        active: true,
      })),
  ]
  const selectedOwner = owners.find((owner) => owner.id === form.ownerContactId)
    || (form.owner ? {
      id: `legacy-${form.owner}`,
      referenceCode: '',
      displayName: form.owner,
      email: '',
      jobTitle: '',
      source: 'external' as const,
      appAccess: false,
      status: 'Legacy',
      active: true,
    } : null)
  const selectableOwners = owners.filter((owner) => owner.active)

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
            disabled={readOnly}
            multiple
            options={selectableProducts}
            value={displayedProducts}
            getOptionLabel={(product) => product.name}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_, values) => setForm({
              ...form,
              productIds: values.filter((product) => !product.id.startsWith('legacy-')).map((product) => product.id),
              name: values.map((product) => product.name.trim()).filter(Boolean).join(', '),
            })}
            renderTags={(value: readonly PipelineCatalogProduct[], getTagProps) =>
              value.map((option, index) => (
                <Chip variant="outlined" size="small" label={option.name} {...getTagProps({ index })} key={`${option.id}-${index}`} />
              ))
            }
            renderInput={(params) => <TextField {...params} label="Product" size="small" placeholder="Select configured products" helperText={products.length ? undefined : 'Add products in Pipeline setup.'} />}
          />
          <TextField disabled={readOnly} label="Priority" select size="small" value={form.priority || ''} onChange={e => setForm({ ...form, priority: e.target.value })}>
            {priorities.map(p => <MenuItem key={p} value={p}>{p}</MenuItem>)}
          </TextField>
          <TextField disabled={readOnly} label="Status" select size="small" value={form.status || ''} onChange={e => setForm({ ...form, status: e.target.value })}>
            {statuses.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </TextField>
          <TextField disabled={readOnly} label="Stage" select size="small" value={form.stage || ''} onChange={e => setForm({ ...form, stage: e.target.value })}>
            {stages.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </TextField>
          <Autocomplete
            disabled={readOnly}
            options={selectableOwners}
            value={selectedOwner}
            getOptionLabel={(owner) => owner.displayName}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_, owner) => setForm({
              ...form,
              ownerContactId: owner && !owner.id.startsWith('legacy-') ? owner.id : undefined,
              owner: owner?.displayName || '',
            })}
            renderInput={(params) => <TextField {...params} label="Owner" size="small" helperText="Organization users and CRM-only team members" />}
          />
          <TextField
            label="Expected Close"
            disabled={readOnly}
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
                  const picker = el as DateInputWithPicker
                  if (typeof picker.showPicker === 'function') {
                    picker.showPicker()
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
            disabled={readOnly}
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
            disabled={readOnly}
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
          <TextField disabled={readOnly} label="Source" select size="small" value={form.source || ''} onChange={e => setForm({ ...form, source: e.target.value })}>
            {sources.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </TextField>
          <TextField disabled={readOnly} label="Loss Reason" select size="small" value={form.lossReason || ''} onChange={e => setForm({ ...form, lossReason: e.target.value })}>
            <MenuItem value="">Not selected</MenuItem>
            {lossReasons.map(l => <MenuItem key={l} value={l}>{l}</MenuItem>)}
          </TextField>
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
        {!readOnly ? (
          <Autocomplete
            multiple
            options={contactOptions.filter((contact) => !form.organizationId || contact.organizationId === form.organizationId)}
            value={(form.contactIds || [])
              .map((contactId) => contactOptions.find((contact) => contact.id === contactId))
              .filter((contact): contact is Contact => Boolean(contact))}
            getOptionLabel={(contact) => contact.name}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_, contacts) => setForm({
              ...form,
              contactIds: contacts.map((contact) => contact.id),
              contacts,
            })}
            renderOption={(props, contact) => (
              <Box component="li" {...props} key={contact.id}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap>{contact.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{contact.title || contact.email || contact.referenceCode}</Typography>
                </Box>
              </Box>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Associated contacts"
                size="small"
                placeholder="Select contacts"
                helperText="Select one or more contacts, then save the opportunity. The first contact is primary."
              />
            )}
            sx={{ mb: 1.5 }}
          />
        ) : null}
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

        {!readOnly ? <Stack direction="row" spacing={1} mt={2}>
          <Button variant="contained" disabled={saving || !form.name.trim()} onClick={async () => {
            try {
              setSaving(true)
              setError('')
              await onSave(form)
            } catch (error: unknown) {
              setError(String(error instanceof Error ? error.message : error))
            } finally {
              setSaving(false)
            }
          }}>Save opportunity</Button>
        </Stack> : null}

        <Divider sx={{ my: 2, borderColor: 'rgba(255,255,255,0.08)' }} />

        {!readOnly ? <><Typography variant="subtitle2" mb={1}>Add comment</Typography>
        <TextField multiline minRows={3} fullWidth value={comment} onChange={e => setComment(e.target.value)} placeholder="Write a comment..." />
        <Stack direction="row" spacing={1} mt={1}>
          <Button variant="outlined" disabled={saving || !comment.trim()} onClick={async () => {
            try {
              setSaving(true)
              setError('')
              await onComment(form.id, comment)
              setComment('')
            } catch (error: unknown) {
              setError(String(error instanceof Error ? error.message : error))
            } finally {
              setSaving(false)
            }
          }}>Append to Notes</Button>
        </Stack></> : null}

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
  const dateTimeSettings = useUserDateTime()
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<'insights' | 'board' | 'list'>('board')
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'terminal'>('all')
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null)
  const [stageOptions, setStageOptions] = useState<string[]>(DEFAULT_STAGES)
  const [priorityOptions, setPriorityOptions] = useState<string[]>(DEFAULT_PRIORITIES)
  const [statusOptions, setStatusOptions] = useState<string[]>(DEFAULT_STATUSES)
  const [sourceOptions, setSourceOptions] = useState<string[]>(DEFAULT_SOURCES)
  const [lossReasonOptions, setLossReasonOptions] = useState<string[]>(DEFAULT_LOSS_REASONS)
  const [catalogPeople, setCatalogPeople] = useState<PipelineCatalogPerson[]>([])
  const [catalogProducts, setCatalogProducts] = useState<PipelineCatalogProduct[]>([])
  const [catalogOpen, setCatalogOpen] = useState(false)
  const compactLandscapeBoard = useMediaQuery('(orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)')
  const mobilePortraitBoard = useMediaQuery('(orientation: portrait) and (max-width: 899.95px)')
  const singleStageBoard = compactLandscapeBoard || mobilePortraitBoard
  const [pipelineGuideOpen, setPipelineGuideOpen] = useState(false)
  const [activeStage, setActiveStage] = useState<string>(DEFAULT_STAGES[0])
  const [syncSurface, setSyncSurface] = useState<SyncSurface>({ state: 'unknown', lastSyncedAt: null, summary: null })
  const [syncingNow, setSyncingNow] = useState(false)
  const [pipelineAccess, setPipelineAccess] = useState<'owner' | 'editor' | 'viewer' | null>(null)
  const [pipelineId, setPipelineId] = useState<string | null>(null)
  const [pipelineSyncEnabled, setPipelineSyncEnabled] = useState(true)
  const [pipelineShortLink, setPipelineShortLink] = useState<string | null>(null)
  const [pipelineProvisioningStatus, setPipelineProvisioningStatus] = useState<PipelineProvisioningStatus>('not_requested')
  const [pipelineProvisioningError, setPipelineProvisioningError] = useState('')
  const [pipelineSheetDialogOpen, setPipelineSheetDialogOpen] = useState(false)
  const [pipelineSheetBusy, setPipelineSheetBusy] = useState(false)
  const [newOpportunityOpen, setNewOpportunityOpen] = useState(false)
  const [creatingOpportunity, setCreatingOpportunity] = useState(false)
  const [newOpportunityError, setNewOpportunityError] = useState('')
  const [newOpportunity, setNewOpportunity] = useState(EMPTY_OPPORTUNITY)
  const [newOpportunityMutationKey, setNewOpportunityMutationKey] = useState('')
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([])
  const [organizationsLoading, setOrganizationsLoading] = useState(false)
  const [contactOptions, setContactOptions] = useState<Contact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [newOrganizationOpen, setNewOrganizationOpen] = useState(false)
  const [creatingOrganization, setCreatingOrganization] = useState(false)
  const [newOrganization, setNewOrganization] = useState({ name: '', email: '', phone: '', description: '' })
  const canEdit = pipelineAccess === 'owner' || pipelineAccess === 'editor'
  const ownerOptions = useMemo(() => catalogPeople.filter((person) => person.active), [catalogPeople])
  const productOptions = useMemo(() => catalogProducts.filter((product) => product.active), [catalogProducts])

  const applyCatalog = useCallback((catalog: PipelineCatalogSnapshot) => {
    setCatalogPeople(catalog.people)
    setCatalogProducts(catalog.products)
    if (catalog.pipelineId) setPipelineId((current) => current || catalog.pipelineId)
  }, [])

  const load = async () => {
    const data = await fetch('/api/pipeline').then(r => r.json())
    if (data?.pipeline) {
      setPipelineId(typeof data.pipeline.id === 'string' ? data.pipeline.id : null)
      setPipelineAccess(data.pipeline.accessRole || null)
      setPipelineSyncEnabled(data.pipeline.syncEnabled === true)
      setPipelineShortLink(typeof data.pipeline.shortLinkUrl === 'string' ? data.pipeline.shortLinkUrl : null)
      setPipelineProvisioningStatus(data.pipeline.provisioningStatus || 'not_requested')
      setPipelineProvisioningError(String(data.pipeline.provisioningError || ''))
    }
    const rows = Array.isArray(data) ? data : (Array.isArray(data.opportunities) ? data.opportunities : [])
    const mapped: Deal[] = rows.map((row: LooseRecord, i: number) => dealFromLooseShape(row, i))
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

      const pendingSync = Number(out?.summary?.pendingSync || 0)
      const failedSync = Number(out?.summary?.failedSync || 0)
      setSyncSurface({
        state: failedSync > 0 ? 'error' : pendingSync > 0 ? 'syncing' : 'ok',
        lastSyncedAt: out?.syncedAt || null,
        summary: out?.summary || null,
        error: failedSync > 0 ? `${failedSync} CRM record${failedSync === 1 ? '' : 's'} failed to synchronize.` : undefined,
        feedback: pendingSync > 0 ? `${pendingSync} CRM record${pendingSync === 1 ? '' : 's'} synchronizing.` : undefined,
      })
    } catch (error: unknown) {
      setSyncSurface({
        state: 'error',
        lastSyncedAt: null,
        summary: null,
        error: String(error instanceof Error ? error.message : error),
      })
    }
  }

  const runManualSync = async () => {
    if (syncingNow || !canEdit || !pipelineSyncEnabled) return

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
    } catch (error: unknown) {
      setSyncSurface((prev) => ({
        ...prev,
        state: 'error',
        error: String(error instanceof Error ? error.message : error),
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
      const active = items.filter((item: DropdownOption) => item?.active !== false)
      const values = active
        .sort((a: DropdownOption, b: DropdownOption) => Number(a?.sort_order || 0) - Number(b?.sort_order || 0))
        .map((item: DropdownOption) => String(item?.label || item?.value || '').trim())
        .filter(Boolean)
      return values.length ? values : fallback
    }

    setStageOptions(pick('stage', DEFAULT_STAGES))
    setPriorityOptions(pick('priority', DEFAULT_PRIORITIES))
    setStatusOptions(pick('status', DEFAULT_STATUSES))
    setSourceOptions(pick('source', DEFAULT_SOURCES))
    setLossReasonOptions(pick('loss_reason', DEFAULT_LOSS_REASONS))
  }

  const loadCatalog = async () => {
    const response = await fetch('/api/pipeline/catalog', { cache: 'no-store' })
    const payload = await response.json().catch(() => ({}))
    if (response.status === 409 && String(payload?.error || '').includes('Postgres storage')) {
      applyCatalog({ pipelineId: '', canEdit: false, people: [], products: [] })
      return
    }
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || 'Unable to load pipeline setup')
    applyCatalog({
      pipelineId: String(payload.pipelineId || ''),
      canEdit: payload.canEdit === true,
      people: Array.isArray(payload.people) ? payload.people : [],
      products: Array.isArray(payload.products) ? payload.products : [],
    })
  }

  useEffect(() => {
    let done = false
    const failsafe = setTimeout(() => {
      if (!done) setLoading(false)
    }, 12000)

    Promise.all([load(), loadDropdowns(), loadCatalog(), loadSyncStatus()])
      .then(() => { done = true; setLoading(false) })
      .catch(e => { done = true; setError(String(e)); setLoading(false) })
      .finally(() => clearTimeout(failsafe))

    return () => clearTimeout(failsafe)
    // Initial workspace selection is restored by the API cookies on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (pipelineProvisioningStatus !== 'queued' && pipelineProvisioningStatus !== 'provisioning') return
    const interval = window.setInterval(() => { void load() }, 2500)
    return () => window.clearInterval(interval)
  }, [pipelineProvisioningStatus])

  useEffect(() => {
    if (!stageOptions.length) return
    if (!stageOptions.includes(activeStage)) setActiveStage(stageOptions[0])
  }, [stageOptions, activeStage])

  useEffect(() => {
    if (!newOpportunityOpen && !selectedDeal) return
    if (newOpportunityOpen && organizations.length === 0 && !organizationsLoading) void loadOrganizations()
    if (contactOptions.length === 0 && !contactsLoading) void loadContacts()
  }, [contactOptions.length, contactsLoading, newOpportunityOpen, organizations.length, organizationsLoading, selectedDeal])

  const filtered = useMemo(() => {
    const scoped = filterStatus === 'active'
      ? deals.filter(d => isActivePipelineStatus(d.status))
      : filterStatus === 'terminal'
        ? deals.filter(d => !isActivePipelineStatus(d.status))
        : deals

    return [...scoped].sort(compareDealsForPriority)
  }, [deals, filterStatus])

  const pipelineSummary = useMemo(() => summarizePipeline(deals) as unknown as PipelineSummary, [deals])
  const highPriorityActiveDeals = useMemo(
    () => pipelineSummary.active.filter((deal: Deal) => ['A+', 'A'].includes((deal.priority || '').trim())),
    [pipelineSummary.active],
  )

  const moveDealStage = async (deal: Deal, direction: -1 | 1) => {
    if (!canEdit) return
    const idx = stageOptions.findIndex(s => s === deal.stage)
    if (idx < 0) return
    const nextIdx = idx + direction
    if (nextIdx < 0 || nextIdx >= stageOptions.length) return
    const nextStage = stageOptions[nextIdx]
    const mutationKey = pipelineMutationKey()

    const res = await fetch(`/api/pipeline/opportunity/${deal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': mutationKey },
      body: JSON.stringify({ expectedUpdatedAt: deal.updatedAt, stage: nextStage }),
    })
    const out = await res.json()
    if (!res.ok) return
    setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, stage: nextStage, updatedAt: out?.opportunity?.updatedAt || d.updatedAt } : d))
  }

  const patchOpportunityWithRetry = async (deal: Deal, body: Record<string, unknown>) => {
    if (!canEdit) throw new Error('This pipeline is view-only')
    let localDeal = { ...deal }
    const mutationKey = pipelineMutationKey()
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`/api/pipeline/opportunity/${localDeal.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': mutationKey },
          body: JSON.stringify({ ...body, expectedUpdatedAt: localDeal.updatedAt }),
        })
        const out = await res.json()

        if (res.status === 409 && attempt === 0) {
          // Refresh latest and retry once with newest updatedAt
          const snap = await fetch('/api/pipeline').then(r => r.json())
          const rows = Array.isArray(snap) ? snap : (Array.isArray(snap?.opportunities) ? snap.opportunities : [])
          const latest = rows.find((row: LooseRecord) => row?.id === localDeal.id)
          if (latest?.updatedAt) {
            localDeal = { ...localDeal, updatedAt: String(latest.updatedAt) }
            continue
          }
        }

        if (!res.ok) throw new Error(out?.error || `Save failed (${res.status})`)
        return out
      } catch (error: unknown) {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 250))
          continue
        }
        throw new Error(`Network/save error: ${String(error instanceof Error ? error.message : error)}`)
      }
    }
    throw new Error('Save failed after retry')
  }

  const createOpportunity = async () => {
    if (!newOpportunity.organizationId || newOpportunity.productIds.length === 0 || creatingOpportunity) return
    setCreatingOpportunity(true)
    setNewOpportunityError('')
    try {
      const response = await fetch('/api/pipeline', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': newOpportunityMutationKey || pipelineMutationKey(),
        },
        body: JSON.stringify({
          organizationId: newOpportunity.organizationId,
          contactIds: newOpportunity.contactIds,
          productIds: newOpportunity.productIds,
          products: productOptions
            .filter((product) => newOpportunity.productIds.includes(product.id))
            .map((product) => product.name),
          ownerContactId: newOpportunity.ownerContactId || null,
          priority: newOpportunity.priority,
          stage: newOpportunity.stage,
          value: Number(newOpportunity.value || 0),
          probability: Number(newOpportunity.probability || 0),
          expectedClose: newOpportunity.expectedClose,
          notes: newOpportunity.notes.trim(),
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to create opportunity')
      await load()
      setNewOpportunity(EMPTY_OPPORTUNITY)
      setNewOpportunityMutationKey('')
      setNewOpportunityOpen(false)
    } catch (createError) {
      setNewOpportunityError(createError instanceof Error ? createError.message : 'Unable to create opportunity')
    } finally {
      setCreatingOpportunity(false)
    }
  }

  const loadOrganizations = async (preferredId?: string) => {
    setOrganizationsLoading(true)
    try {
      const response = await fetch('/api/crm?entity=organizations&limit=500')
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load organizations')
      const nextOrganizations = (Array.isArray(result.records) ? result.records : [])
        .map((record: LooseRecord) => ({
          id: String(record.id || ''),
          name: String(record.name || ''),
          referenceCode: String(record.referenceCode || ''),
          email: String(record.email || ''),
          phone: String(record.phone || ''),
          relationshipType: String(record.relationshipType || ''),
        }))
        .filter((record: OrganizationOption) => record.id && record.name && record.relationshipType === 'customer')
        .sort((left: OrganizationOption, right: OrganizationOption) => left.name.localeCompare(right.name))
      setOrganizations(nextOrganizations)
      if (preferredId && nextOrganizations.some((record: OrganizationOption) => record.id === preferredId)) {
        setNewOpportunity((current) => ({ ...current, organizationId: preferredId }))
      }
    } catch (organizationError) {
      setNewOpportunityError(organizationError instanceof Error ? organizationError.message : 'Unable to load organizations')
    } finally {
      setOrganizationsLoading(false)
    }
  }

  const loadContacts = async () => {
    setContactsLoading(true)
    try {
      const response = await fetch('/api/crm?entity=contacts&limit=1000')
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load contacts')
      const nextContacts = (Array.isArray(result.records) ? result.records : [])
        .map((record: LooseRecord, index: number) => contactFromLooseShape(record, `crm-contact-${index}`))
        .filter((contact: Contact | null): contact is Contact => Boolean(contact?.id && contact.organizationId))
        .sort((left: Contact, right: Contact) => left.name.localeCompare(right.name))
      setContactOptions(nextContacts)
    } catch (contactsError) {
      setNewOpportunityError(contactsError instanceof Error ? contactsError.message : 'Unable to load contacts')
    } finally {
      setContactsLoading(false)
    }
  }

  const createOrganization = async () => {
    if (!newOrganization.name.trim() || creatingOrganization) return
    setCreatingOrganization(true)
    setNewOpportunityError('')
    try {
      const response = await fetch('/api/crm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: 'organizations',
          fields: {
            name: newOrganization.name.trim(),
            email: newOrganization.email.trim(),
            phone: newOrganization.phone.trim(),
            description: newOrganization.description.trim(),
          },
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to create organization')
      const createdId = String(result.record?.id || '')
      await loadOrganizations(createdId)
      setNewOrganization({ name: '', email: '', phone: '', description: '' })
      setNewOrganizationOpen(false)
    } catch (organizationError) {
      setNewOpportunityError(organizationError instanceof Error ? organizationError.message : 'Unable to create organization')
    } finally {
      setCreatingOrganization(false)
    }
  }

  const createOrRepairPipelineSheet = async () => {
    if (!pipelineId || pipelineAccess !== 'owner' || pipelineSheetBusy) return
    setPipelineSheetBusy(true)
    setPipelineProvisioningError('')
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'provision-pipeline', pipelineId }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to prepare the pipeline Sheet')
      const nextStatus = result.actionResult?.provisioningStatus
      if (nextStatus) setPipelineProvisioningStatus(nextStatus)
      setPipelineSheetDialogOpen(false)
      await load()
    } catch (sheetError) {
      setPipelineProvisioningError(sheetError instanceof Error ? sheetError.message : 'Unable to prepare the pipeline Sheet')
    } finally {
      setPipelineSheetBusy(false)
    }
  }

  if (loading) return <Box sx={{ p: 3 }}>{[1, 2, 3].map(i => <Skeleton key={i} variant="rounded" height={80} sx={{ mb: 2 }} />)}</Box>
  if (error) return <Box sx={{ p: 3 }}><Alert severity="error">{error}</Alert></Box>

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: compactLandscapeBoard ? 1 : { xs: 2, md: 3 }, py: compactLandscapeBoard ? 0.75 : 2, borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <Stack
          direction="row"
          spacing={compactLandscapeBoard ? 1.5 : 3}
          alignItems="center"
          flexWrap={compactLandscapeBoard ? 'nowrap' : 'wrap'}
          gap={compactLandscapeBoard ? 0 : 1.25}
          sx={compactLandscapeBoard ? {
            maxWidth: '100%',
            overflowX: 'auto',
            overflowY: 'hidden',
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'thin',
            '& > *': { flexShrink: 0 },
          } : undefined}
        >
          <Box><Typography variant="caption" color="text.disabled">Active Pipeline</Typography><Typography variant="h6" fontWeight={700} lineHeight={1.15} color="#66BB6A">{fmt$(pipelineSummary.activeValue)}</Typography></Box>
          <Box>
            <Typography variant="caption" color="text.disabled">Weighted Value</Typography>
            <Typography variant="h6" fontWeight={700} lineHeight={1.15} color="#A8C7FA">{fmt$(pipelineSummary.weightedActiveValue)}</Typography>
            {!compactLandscapeBoard && <Typography variant="caption" color="text.secondary">Σ(value × win probability)</Typography>}
          </Box>
          <Box><Typography variant="caption" color="text.disabled">Active</Typography><Typography variant="h6" fontWeight={700} lineHeight={1.15}>{pipelineSummary.activeCount}</Typography></Box>
          <Box><Typography variant="caption" color="text.disabled">High Priority</Typography><Typography variant="h6" fontWeight={700} lineHeight={1.15}>{highPriorityActiveDeals.length}</Typography></Box>
          <Box><Typography variant="caption" color="text.disabled">Won</Typography><Typography variant="h6" fontWeight={700} lineHeight={1.15}>{pipelineSummary.wonCount}</Typography></Box>

          <Stack spacing={0.45} sx={{ minWidth: compactLandscapeBoard ? 170 : { xs: '100%', sm: 260 }, maxWidth: compactLandscapeBoard ? 220 : { xs: '100%', md: 460 } }}>
            <Typography variant="caption" sx={{ color: '#A8C7FA', fontWeight: 700 }}>{pipelineSyncEnabled ? 'Pipeline sync' : 'Pipeline storage'}</Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="caption" color="text.disabled">Sync status</Typography>
              <Chip
                size="small"
                label={!pipelineSyncEnabled ? 'App managed' : syncSurface.state === 'syncing' ? 'Syncing…' : syncSurface.state === 'ok' ? 'In sync' : syncSurface.state === 'error' ? 'Sync error' : 'Unknown'}
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
            {!compactLandscapeBoard && <Typography variant="caption" color="text.secondary">{pipelineSyncEnabled ? 'Last synced' : 'Last saved'}: {fmtSyncTime(syncSurface.lastSyncedAt, dateTimeSettings)}</Typography>}
            {syncSurface.feedback && (
              <Typography
                variant="caption"
                color={syncSurface.state === 'error' ? 'error.main' : syncSurface.state === 'ok' ? 'success.main' : 'text.secondary'}
              >
                {syncSurface.feedback}
              </Typography>
            )}
            {pipelineSyncEnabled && syncSurface.state === 'error' && syncSurface.error && (
              <Typography variant="caption" color="error.main">{syncSurface.error}</Typography>
            )}
          </Stack>

          {!compactLandscapeBoard && <Box sx={{ flex: 1 }} />}
          <Stack
            direction="row"
            spacing={1}
            flexWrap={compactLandscapeBoard ? 'nowrap' : 'wrap'}
            useFlexGap
            sx={{ width: compactLandscapeBoard ? 'auto' : { xs: '100%', sm: 'auto' }, justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}
          >
            <WorkspaceSelector kind="pipeline" onAccessChange={(resource) => setPipelineAccess(resource?.accessRole || null)} />
            {pipelineShortLink ? (
              <Button
                component="a"
                href={pipelineShortLink}
                target="_blank"
                rel="noreferrer"
                variant="outlined"
                size="small"
                startIcon={<OpenInNewRounded />}
                sx={{ minHeight: 38, whiteSpace: 'nowrap' }}
              >
                Open Sheet
              </Button>
            ) : pipelineAccess === 'owner' ? (
              <Button
                variant="outlined"
                size="small"
                startIcon={pipelineProvisioningStatus === 'queued' || pipelineProvisioningStatus === 'provisioning'
                  ? <CircularProgress size={16} />
                  : pipelineProvisioningStatus === 'failed' || pipelineProvisioningStatus === 'ready'
                    ? <ReplayRounded />
                    : <AddToDriveRounded />}
                onClick={() => setPipelineSheetDialogOpen(true)}
                disabled={pipelineSheetBusy || pipelineProvisioningStatus === 'queued' || pipelineProvisioningStatus === 'provisioning'}
                sx={{ minHeight: 38, whiteSpace: 'nowrap' }}
              >
                {pipelineProvisioningStatus === 'queued' || pipelineProvisioningStatus === 'provisioning'
                  ? 'Creating Sheet'
                  : pipelineProvisioningStatus === 'ready'
                    ? 'Restore Sheet Link'
                    : pipelineProvisioningStatus === 'failed'
                      ? 'Retry Sheet'
                      : 'Create Sheet'}
              </Button>
            ) : null}
            <Tooltip title="Configure pipeline">
              <span>
                <IconButton
                  aria-label="Open pipeline setup"
                  onClick={() => setCatalogOpen(true)}
                  disabled={!pipelineId}
                  sx={{
                    minWidth: 38,
                    minHeight: 38,
                    border: '1px solid rgba(168,199,250,0.45)',
                    color: '#A8C7FA',
                    borderRadius: 1,
                  }}
                >
                  <TuneRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="How pipeline calculations work">
              <IconButton
                aria-label="Open pipeline guide"
                onClick={() => setPipelineGuideOpen(true)}
                sx={{
                  minWidth: 38,
                  minHeight: 38,
                  border: '1px solid rgba(255,255,255,0.18)',
                  color: 'text.secondary',
                  borderRadius: 1,
                }}
              >
                <HelpOutlineRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            {canEdit ? (
              <Button
                variant="contained"
                size="small"
                startIcon={<AddRounded />}
                onClick={() => {
                  setNewOpportunityMutationKey(pipelineMutationKey())
                  setNewOpportunityError('')
                  setNewOpportunityOpen(true)
                }}
                sx={{ minHeight: 38, whiteSpace: 'nowrap' }}
              >
                New opportunity
              </Button>
            ) : null}
            {pipelineSyncEnabled && canEdit ? (
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
            ) : null}
            <ToggleButtonGroup size="small" value={filterStatus} exclusive onChange={(_, v) => v && setFilterStatus(v)}>
              <ToggleButton value="all">All</ToggleButton>
              <ToggleButton value="active">Active</ToggleButton>
              <ToggleButton value="terminal">Terminal</ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup size="small" value={view} exclusive onChange={(_, v) => v && setView(v)}>
              <Tooltip title="Pipeline insights"><ToggleButton value="insights"><InsightsRounded sx={{ fontSize: 18 }} /></ToggleButton></Tooltip>
              <Tooltip title="Board view"><ToggleButton value="board"><ViewColumnRounded sx={{ fontSize: 18 }} /></ToggleButton></Tooltip>
              <Tooltip title="List view"><ToggleButton value="list"><TableRowsRounded sx={{ fontSize: 18 }} /></ToggleButton></Tooltip>
            </ToggleButtonGroup>
          </Stack>
        </Stack>
      </Box>

      {!loading && canEdit && productOptions.length === 0 ? (
        <Alert
          severity="info"
          action={(
            <Button color="inherit" size="small" onClick={() => setCatalogOpen(true)}>
              Open setup
            </Button>
          )}
          sx={{ mx: { xs: 1, md: 2 }, mt: 1, borderRadius: 1 }}
        >
          Add products and workflow choices before creating the first opportunity.
        </Alert>
      ) : null}

      <Box
        data-testid="pipeline-results"
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          px: { xs: 1, md: 2 },
          py: compactLandscapeBoard ? 0.5 : 2,
          WebkitOverflowScrolling: 'touch',
          touchAction: singleStageBoard ? 'pan-y' : 'auto',
        }}
      >
        {view === 'insights' ? (
          <PipelineInsights
            deals={deals}
            stages={stageOptions}
            onOpenDeal={(deal) => setSelectedDeal(deals.find((candidate) => candidate.id === deal.id) || null)}
          />
        ) : view === 'board' ? (
          singleStageBoard ? (
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

              <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y', pr: 0.5 }}>
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
            {filtered.length === 0 ? (
              <Typography variant="body2" color="text.disabled" sx={{ px: 2, py: 2 }}>
                No opportunities match this filter.
              </Typography>
            ) : filtered.map(deal => (
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

      <Dialog
        open={pipelineGuideOpen}
        onClose={() => setPipelineGuideOpen(false)}
        fullScreen={singleStageBoard}
        fullWidth
        maxWidth="sm"
        PaperProps={{ sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: singleStageBoard ? 0 : 1 } }}
      >
        <DialogTitle sx={{ fontWeight: 700, pr: 7 }}>
          How your pipeline works
          <IconButton
            aria-label="Close pipeline guide"
            onClick={() => setPipelineGuideOpen(false)}
            sx={{ position: 'absolute', right: 12, top: 10 }}
          >
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ py: 2.5 }}>
          <Stack spacing={2.5}>
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>Status controls lifecycle and reporting</Typography>
              <Typography variant="body2" color="text.secondary" mt={0.5}>
                Open and On Hold are active. Closed and Won count as won. Lost and Abandoned count as lost. Active pipeline value excludes every terminal status.
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>Stage controls the board lane</Typography>
              <Typography variant="body2" color="text.secondary" mt={0.5}>
                Moving a card changes its sales-process stage. Stage does not override lifecycle status; contradictory combinations appear in Insights for review.
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>Weighted value is value × probability</Typography>
              <Typography variant="body2" color="text.secondary" mt={0.5}>
                Expected Close places active value into the forecast period. Products can be selected together on one opportunity rather than stored as combination products.
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>The Sheet is a synchronized operator view</Typography>
              <Typography variant="body2" color="text.secondary" mt={0.5}>
                Edit opportunity rows only. ClawPilot generates CRM records, dropdowns, calculations, and dashboard reporting from the same pipeline definitions used here.
              </Typography>
            </Box>
            <Alert severity="info" sx={{ borderRadius: 1 }}>
              Every new pipeline starts with this base workflow. Owners can tailor stages, priorities, statuses, sources, people, and products from Configure pipeline.
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setPipelineGuideOpen(false)}>Done</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={pipelineSheetDialogOpen}
        onClose={pipelineSheetBusy ? undefined : () => setPipelineSheetDialogOpen(false)}
        fullScreen={compactLandscapeBoard}
        fullWidth
        maxWidth="xs"
        PaperProps={{ sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: compactLandscapeBoard ? 0 : 1 } }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>
          {pipelineProvisioningStatus === 'ready'
            ? 'Restore Sheet link?'
            : pipelineProvisioningStatus === 'failed'
              ? 'Retry Sheet setup?'
              : 'Create private Sheet?'}
        </DialogTitle>
        <DialogContent>
          {pipelineProvisioningError ? <Alert severity="error" sx={{ mb: 1.5 }}>{pipelineProvisioningError}</Alert> : null}
          <Typography variant="body2" color="text.secondary">
            {pipelineProvisioningStatus === 'ready'
              ? 'ClawPilot will restore the short link for the existing private Google Sheet.'
              : 'ClawPilot will create the private Drive folder, Google Sheet, sharing permissions, and short link for this pipeline.'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPipelineSheetDialogOpen(false)} disabled={pipelineSheetBusy}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => { void createOrRepairPipelineSheet() }}
            disabled={pipelineSheetBusy}
            startIcon={pipelineSheetBusy ? <CircularProgress size={16} color="inherit" /> : pipelineProvisioningStatus === 'ready' ? <ReplayRounded /> : <AddToDriveRounded />}
          >
            {pipelineProvisioningStatus === 'ready' ? 'Restore link' : pipelineProvisioningStatus === 'failed' ? 'Retry' : 'Create Sheet'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={newOpportunityOpen}
        onClose={creatingOpportunity ? undefined : () => setNewOpportunityOpen(false)}
        fullScreen={compactLandscapeBoard}
        fullWidth
        maxWidth="sm"
        PaperProps={{ sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: compactLandscapeBoard ? 0 : 1 } }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>New opportunity</DialogTitle>
        <DialogContent>
          {newOpportunityError ? <Alert severity="error" sx={{ mb: 2 }}>{newOpportunityError}</Alert> : null}
          <Stack spacing={1.5} mt={0.5}>
            <Autocomplete
              options={organizations}
              loading={organizationsLoading}
              value={organizations.find((organization) => organization.id === newOpportunity.organizationId) || null}
              getOptionLabel={(organization) => organization.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onChange={(_, organization) => setNewOpportunity((current) => ({
                ...current,
                organizationId: organization?.id || '',
                contactIds: [],
              }))}
              renderOption={(props, organization) => (
                <Box component="li" {...props} key={organization.id}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap>{organization.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{organization.referenceCode || organization.email || organization.phone}</Typography>
                  </Box>
                </Box>
              )}
              renderInput={(params) => <TextField {...params} autoFocus required label="Organization" helperText="Select an organization already in CRM" />}
            />
            <Button
              variant="text"
              size="small"
              startIcon={<AddRounded />}
              onClick={() => setNewOrganizationOpen((open) => !open)}
              sx={{ alignSelf: 'flex-start' }}
            >
              {newOrganizationOpen ? 'Cancel new organization' : 'Add organization'}
            </Button>
            {newOrganizationOpen ? (
              <Box sx={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 1, p: 1.5 }}>
                <Stack spacing={1.5}>
                  <Typography variant="subtitle2">New CRM organization</Typography>
                  <TextField required label="Organization name" value={newOrganization.name} onChange={(event) => setNewOrganization((current) => ({ ...current, name: event.target.value }))} />
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField fullWidth label="Primary email" type="email" value={newOrganization.email} onChange={(event) => setNewOrganization((current) => ({ ...current, email: event.target.value }))} />
                    <TextField fullWidth label="Phone" value={newOrganization.phone} onChange={(event) => setNewOrganization((current) => ({ ...current, phone: event.target.value }))} />
                  </Stack>
                  <TextField multiline minRows={2} label="Description" value={newOrganization.description} onChange={(event) => setNewOrganization((current) => ({ ...current, description: event.target.value }))} />
                  <Button variant="outlined" onClick={() => { void createOrganization() }} disabled={creatingOrganization || !newOrganization.name.trim()}>
                    {creatingOrganization ? 'Adding...' : 'Add to CRM'}
                  </Button>
                </Stack>
              </Box>
            ) : null}
            <Autocomplete
              multiple
              disabled={!newOpportunity.organizationId}
              loading={contactsLoading}
              options={contactOptions.filter((contact) => contact.organizationId === newOpportunity.organizationId)}
              value={contactOptions.filter((contact) => newOpportunity.contactIds.includes(contact.id))}
              getOptionLabel={(contact) => contact.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onChange={(_, contacts) => setNewOpportunity((current) => ({
                ...current,
                contactIds: contacts.map((contact) => contact.id),
              }))}
              renderOption={(props, contact) => (
                <Box component="li" {...props} key={contact.id}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap>{contact.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{contact.title || contact.email || contact.referenceCode}</Typography>
                  </Box>
                </Box>
              )}
              renderInput={(params) => (
                <TextField {...params} label="Associated contacts" helperText="Optional: select contacts involved in this opportunity" />
              )}
            />
            <Autocomplete
              multiple
              options={productOptions}
              value={productOptions.filter((product) => newOpportunity.productIds.includes(product.id))}
              getOptionLabel={(product) => product.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onChange={(_, products) => setNewOpportunity((current) => ({ ...current, productIds: products.map((product) => product.id) }))}
              renderOption={(props, product) => (
                <Box component="li" {...props} key={product.id}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap>{product.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{product.sku || product.referenceCode}{product.category ? ` · ${product.category}` : ''}</Typography>
                  </Box>
                </Box>
              )}
              renderTags={(value: readonly PipelineCatalogProduct[], getTagProps) =>
                value.map((product, index) => (
                  <Chip variant="outlined" size="small" label={product.name} {...getTagProps({ index })} key={product.id} />
                ))
              }
              renderInput={(params) => (
                <TextField {...params} required label="Product" helperText={productOptions.length ? 'Select one or more products owned by this organization' : 'Add products in Pipeline setup first'} />
              )}
            />
            <Autocomplete
              options={ownerOptions}
              value={ownerOptions.find((person) => person.id === newOpportunity.ownerContactId) || null}
              getOptionLabel={(person) => person.displayName}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onChange={(_, person) => setNewOpportunity((current) => ({ ...current, ownerContactId: person?.id || '' }))}
              renderOption={(props, person) => (
                <Box component="li" {...props} key={person.id}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap>{person.displayName}</Typography>
                    <Typography variant="caption" color="text.secondary">{person.appAccess ? 'ClawPilot user' : 'CRM-only team member'}{person.jobTitle ? ` · ${person.jobTitle}` : ''}</Typography>
                  </Box>
                </Box>
              )}
              renderInput={(params) => <TextField {...params} label="Owner" helperText="Optional: organization user or CRM-only team member" />}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField select fullWidth label="Priority" value={newOpportunity.priority} onChange={(event) => setNewOpportunity((current) => ({ ...current, priority: event.target.value }))}>
                {priorityOptions.map((priority) => <MenuItem key={priority} value={priority}>{priority}</MenuItem>)}
              </TextField>
              <TextField select fullWidth label="Stage" value={newOpportunity.stage} onChange={(event) => setNewOpportunity((current) => ({ ...current, stage: event.target.value }))}>
                {stageOptions.map((stage) => <MenuItem key={stage} value={stage}>{stage}</MenuItem>)}
              </TextField>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField fullWidth label="Value" inputMode="decimal" value={newOpportunity.value} onChange={(event) => setNewOpportunity((current) => ({ ...current, value: event.target.value.replace(/[^0-9.]/g, '') }))} />
              <TextField fullWidth label="Probability" inputMode="decimal" value={newOpportunity.probability} onChange={(event) => setNewOpportunity((current) => ({ ...current, probability: event.target.value.replace(/[^0-9.]/g, '') }))} />
            </Stack>
            <TextField
              fullWidth
              type="date"
              label="Expected close"
              value={newOpportunity.expectedClose}
              onChange={(event) => setNewOpportunity((current) => ({ ...current, expectedClose: event.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField multiline minRows={3} label="Notes" value={newOpportunity.notes} onChange={(event) => setNewOpportunity((current) => ({ ...current, notes: event.target.value }))} />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => {
            setNewOpportunityOpen(false)
            setNewOpportunityMutationKey('')
          }} disabled={creatingOpportunity}>Cancel</Button>
          <Button variant="contained" onClick={createOpportunity} disabled={creatingOpportunity || !newOpportunity.organizationId || newOpportunity.productIds.length === 0}>
            {creatingOpportunity ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      <PipelineCatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onCatalogChange={applyCatalog}
      />

      <DealDrawer
        deal={selectedDeal}
        readOnly={!canEdit}
        onClose={() => setSelectedDeal(null)}
        priorities={priorityOptions}
        statuses={statusOptions}
        stages={stageOptions}
        sources={sourceOptions}
        owners={catalogPeople}
        lossReasons={lossReasonOptions}
        products={catalogProducts}
        contactOptions={contactOptions}
        onSave={async (deal) => {
          const out = await patchOpportunityWithRetry(deal, {
            products: deal.name.split(',').map((product) => product.trim()).filter(Boolean),
            productIds: deal.productIds || [],
            priority: deal.priority,
            status: deal.status,
            stage: deal.stage,
            owner: deal.owner,
            ownerContactId: deal.ownerContactId || null,
            closeDate: fromInputDate(deal.closeDate),
            value: Math.round(Number(deal.value || 0)),
            probability: Math.round(Number(deal.probability || 0) * 10) / 10,
            source: deal.source,
            lossReason: deal.lossReason,
            contactIds: deal.contactIds || [],
          })
          await load()
          setSelectedDeal(out.opportunity ? dealFromLooseShape(out.opportunity) : null)
        }}
        onComment={async (id, comment) => {
          const mutationKey = pipelineMutationKey()
          const res = await fetch(`/api/pipeline/opportunity/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': mutationKey },
            body: JSON.stringify({ appendComment: comment, expectedUpdatedAt: selectedDeal?.updatedAt }),
          })
          const out = await res.json()
          if (!res.ok) throw new Error(out?.error || 'comment failed')
          await load()
          setSelectedDeal(out.opportunity ? dealFromLooseShape(out.opportunity) : null)
        }}
      />
    </Box>
  )
}
