'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'

type DataRecord = Record<string, unknown>
type MoneyFormatter = (amount: number, compact?: boolean) => string
type NumberFormatter = (value: number, maximumFractionDigits?: number) => string

type PosAccountingPanelProps = {
  location: string
  businessDate: string
  revision: number
  money: MoneyFormatter
  number: NumberFormatter
}

type TargetOption = {
  id: string
  name: string
  detail: string
}

type MappingDraft = {
  sourceKind: string
  sourceId: string
  sourceName: string
  targetType: string
  targetId: string
  targetName: string
  active: boolean
}

const panelSx = {
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '8px',
  backgroundColor: '#15151D',
}

const controlSx = {
  minWidth: 0,
  '& .MuiInputBase-root': { minHeight: 40, borderRadius: '8px', backgroundColor: '#121219' },
  '& input': { minWidth: 0 },
}

const PROFILE_FIELDS = [
  'postingMethod', 'quickBooksClassId', 'quickBooksClassName',
  'quickBooksDepartmentId', 'quickBooksDepartmentName',
  'quickBooksCustomerId', 'quickBooksCustomerName',
  'quickBooksClearingAccountId', 'quickBooksClearingAccountName',
  'trackSalesTax', 'breakoutDimensions', 'memoMode', 'customMemo',
  'customTransactionNumber', 'transactionNumberSuffix', 'suppressZeroOverShort',
  'autoPayoutTips', 'depositChecksWithCash', 'openCheckPolicy', 'batchHoldPolicy',
] as const

const DIMENSION_TARGET_TYPES = ['class', 'department', 'location', 'customer', 'vendor']
const BREAKOUT_DIMENSIONS = [
  ['revenue_center', 'Revenue center'],
  ['day_part', 'Day part'],
  ['dining_option', 'Dining option'],
  ['order_source', 'Order source'],
  ['payment_type', 'Payment type'],
  ['tax_treatment', 'Tax treatment'],
] as const

function record(value: unknown): DataRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DataRecord : {}
}

function rows(value: unknown): DataRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : []
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() || fallback : fallback
}

function amount(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function targetTypeFor(sourceKind: string, current = '') {
  if (current) return current
  if (['sales_item', 'sales_category', 'discount'].includes(sourceKind)) return 'item'
  if (sourceKind === 'tax') return 'tax_code'
  if (['revenue_center', 'day_part', 'dining_option', 'order_source', 'payment_type', 'tax_treatment'].includes(sourceKind)) return 'class'
  return 'account'
}

function targetTypesFor(sourceKind: string) {
  if (['sales_item', 'sales_category', 'discount'].includes(sourceKind)) return ['item']
  if (sourceKind === 'tax') return ['tax_code']
  if (['revenue_center', 'day_part', 'dining_option', 'order_source', 'payment_type', 'tax_treatment'].includes(sourceKind)) return DIMENSION_TARGET_TYPES
  return ['account']
}

function option(value: DataRecord, fallbackName = 'QuickBooks target'): TargetOption {
  const name = text(value.fullyQualifiedName || value.displayName || value.name, fallbackName)
  return {
    id: text(value.id),
    name,
    detail: text(value.accountType || value.itemType || value.companyName),
  }
}

function profilePayload(profile: DataRecord) {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field, profile[field]]))
}

function mappingFromSource(source: DataRecord, current: DataRecord | undefined): MappingDraft {
  const sourceKind = text(source.sourceKind)
  return {
    sourceKind,
    sourceId: text(source.sourceId),
    sourceName: text(source.sourceName, 'POS source'),
    targetType: targetTypeFor(sourceKind, text(current?.targetType)),
    targetId: text(current?.targetId),
    targetName: text(current?.targetName),
    active: current ? current.active !== false : true,
  }
}

function ReadinessChip({ ready, readyLabel, waitingLabel }: {
  ready: boolean
  readyLabel: string
  waitingLabel: string
}) {
  return <Chip size="small" variant="outlined" color={ready ? 'success' : 'warning'} label={ready ? readyLabel : waitingLabel} />
}

export default function PosAccountingPanel({ location, businessDate, revision, money, number }: PosAccountingPanelProps) {
  const [workspace, setWorkspace] = useState<DataRecord | null>(null)
  const [profile, setProfile] = useState<DataRecord>({})
  const [scope, setScope] = useState('organization_default')
  const [mappingDrafts, setMappingDrafts] = useState<MappingDraft[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingMappings, setSavingMappings] = useState(false)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [refreshingQuickBooks, setRefreshingQuickBooks] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ date: businessDate })
    if (location) params.set('location', location)
    setLoading(true)
    setError(null)

    async function load() {
      try {
        const response = await fetch(`/api/pos/accounting?${params}`, { cache: 'no-store', signal: controller.signal })
        const payload = await response.json().catch(() => ({})) as DataRecord
        if (!response.ok || payload.ok !== true || !payload.accounting) {
          throw new Error(text(payload.error, 'POS accounting is unavailable'))
        }
        const next = record(payload.accounting)
        const effectiveProfile = record(next.profile)
        const effectiveMappings = rows(next.mappings)
        const nextCapabilities = record(payload.capabilities)
        const currentBySource = new Map(effectiveMappings.map((entry) => [
          `${text(entry.sourceKind)}:${text(entry.sourceId)}`,
          entry,
        ]))
        setWorkspace({ ...next, capabilities: nextCapabilities })
        setProfile(effectiveProfile)
        setScope(nextCapabilities.canManage === true
          ? text(effectiveProfile.scope, 'organization_default')
          : 'location_override')
        setMappingDrafts(rows(next.sourceCatalog).map((source) => (
          mappingFromSource(source, currentBySource.get(`${text(source.sourceKind)}:${text(source.sourceId)}`))
        )))
      } catch (loadError) {
        if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    void load()
    return () => controller.abort()
  }, [businessDate, location, reload, revision])

  const capabilities = record(workspace?.capabilities)
  const canEdit = capabilities.canManage === true
    || (capabilities.canPrepare === true && scope === 'location_override')
  const locationRecord = record(workspace?.location)
  const quickBooks = record(workspace?.quickBooks)
  const targets = record(workspace?.targets)
  const preview = record(workspace?.preview)
  const receipt = record(preview.salesReceipt)
  const journal = record(preview.journal)
  const readiness = record(preview.readiness)
  const evidence = record(preview.evidence)
  const sourceCatalog = rows(workspace?.sourceCatalog)
  const missingMappings = rows(readiness.missingMappings)

  const targetOptions = useMemo(() => {
    const make = (value: unknown) => rows(value).map((entry) => option(entry)).filter((entry) => entry.id)
    return {
      account: make(targets.accounts),
      item: make(targets.items),
      customer: make(targets.customers),
      vendor: make(targets.vendors),
      tax_code: make(targets.taxCodes),
      class: make(targets.classes),
      department: make(targets.departments),
      location: make(targets.locations),
    } as Record<string, TargetOption[]>
  }, [targets])

  const visibleMappings = useMemo(() => {
    const term = search.trim().toLowerCase()
    return mappingDrafts.filter((entry) => !term || `${entry.sourceName} ${entry.sourceKind} ${entry.targetName}`.toLowerCase().includes(term))
  }, [mappingDrafts, search])

  const mappedCount = mappingDrafts.filter((entry) => entry.active && entry.targetId).length
  const locationGuid = text(locationRecord.restaurantGuid)

  function updateProfile(field: string, value: unknown) {
    setProfile((current) => ({ ...current, [field]: value }))
  }

  function toggleBreakoutDimension(dimension: string, checked: boolean) {
    const current = Array.isArray(profile.breakoutDimensions)
      ? profile.breakoutDimensions.map(String)
      : []
    updateProfile(
      'breakoutDimensions',
      checked
        ? [...new Set([...current, dimension])]
        : current.filter((entry) => entry !== dimension),
    )
  }

  function updateMapping(sourceKind: string, sourceId: string, patch: Partial<MappingDraft>) {
    setMappingDrafts((current) => current.map((entry) => (
      entry.sourceKind === sourceKind && entry.sourceId === sourceId ? { ...entry, ...patch } : entry
    )))
  }

  async function saveProfile() {
    setSavingProfile(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/pos/accounting', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-profile',
          scope,
          restaurantGuid: locationGuid,
          businessDate,
          profile: profilePayload(profile),
        }),
      })
      const payload = await response.json().catch(() => ({})) as DataRecord
      if (!response.ok || payload.ok !== true) throw new Error(text(payload.error, 'Accounting profile could not be saved'))
      setNotice('Accounting profile saved as a new revision.')
      setReload((value) => value + 1)
    } catch (saveError) {
      setError((saveError as Error).message)
    } finally {
      setSavingProfile(false)
    }
  }

  async function saveMappings() {
    setSavingMappings(true)
    setError(null)
    setNotice(null)
    try {
      const mappings = mappingDrafts.filter((entry) => entry.targetId && entry.targetName)
      const response = await fetch('/api/pos/accounting', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-mappings',
          scope,
          restaurantGuid: locationGuid,
          businessDate,
          mappings,
        }),
      })
      const payload = await response.json().catch(() => ({})) as DataRecord
      if (!response.ok || payload.ok !== true) throw new Error(text(payload.error, 'Accounting mappings could not be saved'))
      setNotice('Accounting mappings saved as a new revision.')
      setReload((value) => value + 1)
    } catch (saveError) {
      setError((saveError as Error).message)
    } finally {
      setSavingMappings(false)
    }
  }

  async function refreshCatalog() {
    setRefreshingCatalog(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/pos/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
      const payload = await response.json().catch(() => ({})) as DataRecord
      if (!response.ok || payload.ok !== true) throw new Error(text(payload.error, 'Toast menu catalog could not be refreshed'))
      setNotice('Toast menu catalog refreshed.')
      setReload((value) => value + 1)
    } catch (refreshError) {
      setError((refreshError as Error).message)
    } finally {
      setRefreshingCatalog(false)
    }
  }

  async function refreshQuickBooksCatalog() {
    setRefreshingQuickBooks(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/integrations/quickbooks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh-catalog' }),
      })
      const payload = await response.json().catch(() => ({})) as DataRecord
      if (!response.ok || payload.ok !== true) throw new Error(text(payload.error, 'QuickBooks catalog refresh could not be queued'))
      setNotice('QuickBooks catalog refresh queued. New references appear after the accounting worker completes.')
      setReload((value) => value + 1)
    } catch (refreshError) {
      setError((refreshError as Error).message)
    } finally {
      setRefreshingQuickBooks(false)
    }
  }

  if (loading && !workspace) {
    return <Box minHeight={220} display="grid" sx={{ placeItems: 'center' }}><CircularProgress size={28} /></Box>
  }

  return (
    <Stack spacing={2}>
      {error ? <Alert severity="error" sx={{ borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice(null)} sx={{ borderRadius: '8px' }}>{notice}</Alert> : null}

      <Box sx={{ ...panelSx, p: { xs: 1.5, sm: 2 } }}>
        <Box display="flex" flexDirection={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }} gap={1.5}>
          <Box minWidth={0}>
            <Box display="flex" alignItems="center" gap={0.75} flexWrap="wrap">
              <AccountBalanceRounded sx={{ color: '#A8C7FA' }} />
              <Typography fontWeight={700}>Posting configuration</Typography>
              <ReadinessChip ready={quickBooks.bound === true} readyLabel="QuickBooks bound" waitingLabel="QuickBooks not bound" />
              <Chip size="small" variant="outlined" label={`Revision ${number(amount(profile.profileRevision))}`} />
            </Box>
            <Typography variant="caption" color="text.secondary" display="block" mt={0.4}>
              {text(quickBooks.companyName, 'No QuickBooks company')} | {text(locationRecord.locationName || locationRecord.restaurantName, 'Selected Toast location')}
            </Typography>
          </Box>
          <Box display="flex" gap={1} flexWrap="wrap">
            <Tooltip title="Refresh the stable Toast menu catalog before mapping products">
              <span>
                <Button variant="outlined" size="small" startIcon={refreshingCatalog ? <CircularProgress size={16} /> : <RefreshRounded />} onClick={refreshCatalog} disabled={!canEdit || refreshingCatalog}>
                  Menu catalog
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Queue a tenant-scoped refresh of QuickBooks accounts, items, tax codes, classes, and locations">
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={refreshingQuickBooks ? <CircularProgress size={16} /> : <AccountBalanceRounded />}
                  onClick={refreshQuickBooksCatalog}
                  disabled={capabilities.canManage !== true || refreshingQuickBooks || quickBooks.bound !== true}
                >
                  QuickBooks catalog
                </Button>
              </span>
            </Tooltip>
            <Button variant="contained" size="small" startIcon={savingProfile ? <CircularProgress size={16} /> : <SaveRounded />} onClick={saveProfile} disabled={!canEdit || savingProfile}>
              Save profile
            </Button>
          </Box>
        </Box>

        <Box display="flex" gap={0.75} flexWrap="wrap" mt={1.25}>
          {[
            ['Accounts', record(quickBooks.catalog).accounts],
            ['Items', record(quickBooks.catalog).items],
            ['Tax codes', record(quickBooks.catalog).taxCodes],
            ['Classes', record(quickBooks.catalog).classes],
            ['Locations', record(quickBooks.catalog).departments],
          ].map(([label, value]) => (
            <Chip key={String(label)} size="small" variant="outlined" label={`${label}: ${number(amount(value))}`} />
          ))}
        </Box>

        <Divider sx={{ my: 1.75 }} />
        <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }} gap={1.25}>
          <TextField select label="Configuration scope" value={scope} onChange={(event) => setScope(event.target.value)} size="small" sx={controlSx} disabled={capabilities.canManage !== true}>
            <MenuItem value="organization_default">Organization default</MenuItem>
            <MenuItem value="location_override" disabled={!locationGuid}>Location override</MenuItem>
          </TextField>
          <TextField select label="Posting method" value={text(profile.postingMethod, 'itemized_sales_receipt')} onChange={(event) => updateProfile('postingMethod', event.target.value)} size="small" sx={controlSx} disabled={!canEdit}>
            <MenuItem value="itemized_sales_receipt">Itemized sales receipt</MenuItem>
            <MenuItem value="summary_sales_receipt">Summary sales receipt</MenuItem>
            <MenuItem value="journal_entry">Journal entry</MenuItem>
          </TextField>
          <Autocomplete
            options={targetOptions.account}
            value={targetOptions.account.find((entry) => entry.id === text(profile.quickBooksClearingAccountId)) || null}
            getOptionLabel={(entry) => entry.name}
            isOptionEqualToValue={(left, right) => left.id === right.id}
            onChange={(_, value) => {
              updateProfile('quickBooksClearingAccountId', value?.id || null)
              updateProfile('quickBooksClearingAccountName', value?.name || null)
            }}
            disabled={!canEdit}
            renderInput={(params) => <TextField {...params} label="Clearing account" size="small" sx={controlSx} />}
          />
          <Autocomplete
            options={targetOptions.class}
            value={targetOptions.class.find((entry) => entry.id === text(profile.quickBooksClassId)) || null}
            getOptionLabel={(entry) => entry.name}
            isOptionEqualToValue={(left, right) => left.id === right.id}
            onChange={(_, value) => {
              updateProfile('quickBooksClassId', value?.id || null)
              updateProfile('quickBooksClassName', value?.name || null)
            }}
            disabled={!canEdit}
            renderInput={(params) => <TextField {...params} label="QuickBooks class (optional)" size="small" sx={controlSx} />}
          />
          <Autocomplete
            options={targetOptions.department}
            value={targetOptions.department.find((entry) => entry.id === text(profile.quickBooksDepartmentId)) || null}
            getOptionLabel={(entry) => entry.name}
            isOptionEqualToValue={(left, right) => left.id === right.id}
            onChange={(_, value) => {
              updateProfile('quickBooksDepartmentId', value?.id || null)
              updateProfile('quickBooksDepartmentName', value?.name || null)
            }}
            disabled={!canEdit}
            renderInput={(params) => <TextField {...params} label="QuickBooks location (optional)" size="small" sx={controlSx} />}
          />
          <Autocomplete
            options={targetOptions.customer}
            value={targetOptions.customer.find((entry) => entry.id === text(profile.quickBooksCustomerId)) || null}
            getOptionLabel={(entry) => entry.name}
            isOptionEqualToValue={(left, right) => left.id === right.id}
            onChange={(_, value) => {
              updateProfile('quickBooksCustomerId', value?.id || null)
              updateProfile('quickBooksCustomerName', value?.name || null)
            }}
            disabled={!canEdit}
            renderInput={(params) => <TextField {...params} label="QuickBooks customer (optional)" size="small" sx={controlSx} />}
          />
          <TextField select label="Memo" value={text(profile.memoMode, 'pos_date')} onChange={(event) => updateProfile('memoMode', event.target.value)} size="small" sx={controlSx} disabled={!canEdit}>
            <MenuItem value="pos_date">POS + date</MenuItem>
            <MenuItem value="store_date">Store + date</MenuItem>
            <MenuItem value="location">Location</MenuItem>
            <MenuItem value="custom">Custom</MenuItem>
          </TextField>
          {profile.memoMode === 'custom' ? <TextField label="Custom memo" value={text(profile.customMemo)} onChange={(event) => updateProfile('customMemo', event.target.value)} size="small" sx={controlSx} disabled={!canEdit} /> : null}
          <TextField select label="Open checks" value={text(profile.openCheckPolicy, 'hold')} onChange={(event) => updateProfile('openCheckPolicy', event.target.value)} size="small" sx={controlSx} disabled={!canEdit}>
            <MenuItem value="hold">Hold batch</MenuItem>
            <MenuItem value="exclude">Exclude open checks</MenuItem>
            <MenuItem value="include">Include open checks</MenuItem>
          </TextField>
          <TextField select label="Batch hold" value={text(profile.batchHoldPolicy, 'hold_until_closed')} onChange={(event) => updateProfile('batchHoldPolicy', event.target.value)} size="small" sx={controlSx} disabled={!canEdit}>
            <MenuItem value="hold_until_closed">Until closed</MenuItem>
            <MenuItem value="hold_until_settled">Until settled</MenuItem>
            <MenuItem value="do_not_hold">Do not hold</MenuItem>
          </TextField>
          <TextField label="Transaction suffix" value={text(profile.transactionNumberSuffix)} onChange={(event) => updateProfile('transactionNumberSuffix', event.target.value)} size="small" sx={controlSx} disabled={!canEdit || profile.customTransactionNumber !== true} />
        </Box>
        <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }} mt={1.25}>
          {[
            ['trackSalesTax', 'Track sales tax'],
            ['depositChecksWithCash', 'Deposit checks with cash'],
            ['suppressZeroOverShort', 'Suppress zero over/short'],
            ['autoPayoutTips', 'Auto-payout tips'],
            ['customTransactionNumber', 'Custom transaction number'],
          ].map(([field, label]) => (
            <FormControlLabel key={field} control={<Switch checked={profile[field] === true} onChange={(event) => updateProfile(field, event.target.checked)} disabled={!canEdit} />} label={label} />
          ))}
        </Box>
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>Break out sales by</Typography>
        <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', lg: 'repeat(6, minmax(0, 1fr))' }} gap={0.5}>
          {BREAKOUT_DIMENSIONS.map(([dimension, label]) => (
            <FormControlLabel
              key={dimension}
              control={(
                <Switch
                  size="small"
                  checked={Array.isArray(profile.breakoutDimensions) && profile.breakoutDimensions.includes(dimension)}
                  onChange={(event) => toggleBreakoutDimension(dimension, event.target.checked)}
                  disabled={!canEdit}
                />
              )}
              label={label}
              sx={{ minWidth: 0, mr: 0, '& .MuiFormControlLabel-label': { fontSize: '0.82rem' } }}
            />
          ))}
        </Box>
      </Box>

      <Box sx={{ ...panelSx, overflow: 'hidden' }}>
        <Box px={{ xs: 1.5, sm: 2 }} py={1.5} display="flex" flexDirection={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" gap={1.25}>
          <Box minWidth={0}>
            <Box display="flex" alignItems="center" gap={0.75}>
              <Inventory2Rounded sx={{ color: '#A8C7FA' }} />
              <Typography fontWeight={700}>Catalog mappings</Typography>
              <Chip size="small" variant="outlined" color={missingMappings.length ? 'warning' : 'success'} label={`${number(mappedCount)}/${number(sourceCatalog.length)} mapped`} />
            </Box>
            <Typography variant="caption" color="text.secondary">Toast sources to stable QuickBooks targets</Typography>
          </Box>
          <Box display="flex" gap={1}>
            <TextField
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search mappings"
              size="small"
              sx={{ ...controlSx, width: { xs: '100%', sm: 260 } }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
            />
            <Button variant="outlined" size="small" startIcon={savingMappings ? <CircularProgress size={16} /> : <SaveRounded />} onClick={saveMappings} disabled={!canEdit || savingMappings}>
              Save
            </Button>
          </Box>
        </Box>
        {visibleMappings.map((mapping) => {
          const options = targetOptions[mapping.targetType] || []
          const selected = mapping.active
            ? options.find((entry) => entry.id === mapping.targetId)
              || (mapping.targetId ? { id: mapping.targetId, name: mapping.targetName || mapping.targetId, detail: 'Saved target' } : null)
            : null
          return (
            <Box key={`${mapping.sourceKind}:${mapping.sourceId}`} px={{ xs: 1.5, sm: 2 }} py={1.25} borderTop="1px solid rgba(255,255,255,0.065)" display="grid" gridTemplateColumns={{ xs: '1fr', md: 'minmax(180px, 0.8fr) 150px minmax(240px, 1.2fr)' }} gap={1.25} alignItems="center">
              <Box minWidth={0}>
                <Typography variant="body2" fontWeight={650} noWrap>{mapping.sourceName}</Typography>
                <Typography variant="caption" color="text.secondary" display="block" noWrap>{mapping.sourceKind.replaceAll('_', ' ')}</Typography>
              </Box>
              <TextField
                select
                label="Target type"
                size="small"
                value={mapping.targetType}
                onChange={(event) => updateMapping(mapping.sourceKind, mapping.sourceId, { targetType: event.target.value, targetId: '', targetName: '' })}
                disabled={!canEdit || targetTypesFor(mapping.sourceKind).length === 1}
                sx={controlSx}
              >
                {targetTypesFor(mapping.sourceKind).map((entry) => <MenuItem key={entry} value={entry}>{entry.replaceAll('_', ' ')}</MenuItem>)}
              </TextField>
              <Autocomplete
                options={options}
                value={selected}
                getOptionLabel={(entry) => entry.name}
                isOptionEqualToValue={(left, right) => left.id === right.id}
                onChange={(_, value) => updateMapping(mapping.sourceKind, mapping.sourceId, value
                  ? { targetId: value.id, targetName: value.name, active: true }
                  : { active: false })}
                disabled={!canEdit || !options.length}
                renderInput={(params) => <TextField {...params} label={options.length ? 'QuickBooks target' : 'Refresh QuickBooks catalog'} size="small" sx={controlSx} />}
              />
            </Box>
          )
        })}
        {!visibleMappings.length ? <Typography variant="body2" color="text.secondary" px={2} py={2}>{search ? 'No mappings match this search.' : 'No Toast sources are available yet.'}</Typography> : null}
      </Box>

      <Box display="grid" gridTemplateColumns={{ xs: '1fr', lg: 'minmax(0, 1.35fr) minmax(300px, 0.65fr)' }} gap={2}>
        <Box sx={{ ...panelSx, overflow: 'hidden' }}>
          <Box px={{ xs: 1.5, sm: 2 }} py={1.5} display="flex" justifyContent="space-between" alignItems="center" gap={1.5}>
            <Box>
              <Typography fontWeight={700}>Posting preview</Typography>
              <Typography variant="caption" color="text.secondary">{text(receipt.memo, `POS ${businessDate}`)}</Typography>
            </Box>
            <ReadinessChip ready={readiness.readyForReview === true} readyLabel="Ready for review" waitingLabel="On hold" />
          </Box>
          <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }} gap={1.25} px={{ xs: 1.5, sm: 2 }} pb={1.5}>
            <Box><Typography variant="caption" color="text.disabled">Subtotal</Typography><Typography fontWeight={700}>{money(amount(receipt.subtotal))}</Typography></Box>
            <Box><Typography variant="caption" color="text.disabled">Tax</Typography><Typography fontWeight={700}>{money(amount(receipt.tax))}</Typography></Box>
            <Box><Typography variant="caption" color="text.disabled">Tips</Typography><Typography fontWeight={700}>{money(amount(receipt.tips))}</Typography></Box>
            <Box><Typography variant="caption" color="text.disabled">Total</Typography><Typography fontWeight={700}>{money(amount(receipt.total))}</Typography></Box>
          </Box>
          <Divider />
          {rows(journal.lines).map((line, index) => {
            const target = record(line.target)
            return (
              <Box key={`${text(line.code)}-${index}`} px={{ xs: 1.5, sm: 2 }} py={1} display="grid" gridTemplateColumns="auto minmax(0, 1fr) auto" gap={1} alignItems="center" borderBottom="1px solid rgba(255,255,255,0.055)">
                <Typography variant="caption" color={text(line.side) === 'debit' ? '#A8C7FA' : '#CFC6EA'} fontWeight={700}>{text(line.side).toUpperCase()}</Typography>
                <Box minWidth={0}><Typography variant="body2" noWrap>{text(line.label)}</Typography><Typography variant="caption" color={target.id ? 'text.secondary' : 'warning.main'} display="block" noWrap>{target.name ? text(target.name) : 'Mapping required'}</Typography></Box>
                <Typography variant="body2" fontWeight={650}>{money(amount(line.amount))}</Typography>
              </Box>
            )
          })}
          <Box px={{ xs: 1.5, sm: 2 }} py={1.25} display="flex" justifyContent="space-between" alignItems="center" gap={1.5}>
            <Typography variant="body2" fontWeight={700}>Balance</Typography>
            <Chip size="small" variant="outlined" color={journal.balanced === true ? 'success' : 'error'} label={money(amount(journal.balance))} />
          </Box>
        </Box>

        <Box sx={{ ...panelSx, p: { xs: 1.5, sm: 2 }, alignSelf: 'start' }}>
          <Box display="flex" alignItems="center" gap={0.75} mb={1}>
            {readiness.hold === true ? <ErrorOutlineRounded color="warning" /> : <CheckCircleRounded color="success" />}
            <Typography fontWeight={700}>Review controls</Typography>
          </Box>
          <Stack spacing={1}>
            {(Array.isArray(readiness.holdReasons) ? readiness.holdReasons : []).map((reason, index) => (
              <Typography key={`${text(reason)}-${index}`} variant="body2" color="text.secondary">{text(reason)}</Typography>
            ))}
            {evidence.protected === true ? <Alert severity="info" sx={{ borderRadius: '8px' }}>Approved or posted evidence is immutable.</Alert> : null}
            <Alert severity="info" sx={{ borderRadius: '8px' }}>
              Posting is disabled. This screen prepares and validates accounting evidence only.
            </Alert>
          </Stack>
        </Box>
      </Box>
    </Stack>
  )
}
