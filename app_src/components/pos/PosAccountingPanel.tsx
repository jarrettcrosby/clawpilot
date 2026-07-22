'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
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
import AddRounded from '@mui/icons-material/AddRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import { buildAccountingDraftReviewUrl } from '@/lib/accountingDraftNavigation'

type DataRecord = Record<string, unknown>
type MoneyFormatter = (amount: number, compact?: boolean) => string
type NumberFormatter = (value: number, maximumFractionDigits?: number) => string
type MappingScope = 'organization_default' | 'location_override'

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
  classification: string
  accountType: string
  itemType: string
}

type MappingDraft = {
  sourceKind: string
  sourceId: string
  sourceName: string
  targetType: string
  targetId: string
  targetName: string
  active: boolean
  suggested: boolean
  suggestionConfidence: string
}

type ProductDraft = {
  clientRequestId: string
  sourceKind: 'sales_item'
  sourceId: string
  sourceRestaurantGuid: string
  mappingScope: MappingScope
  name: string
  itemType: 'Service' | 'NonInventory'
  sku: string
  description: string
  unitPrice: string
  purchaseCost: string
  incomeAccountId: string
  expenseAccountId: string
  parentCategoryId: string
  taxable: boolean
}

type PreparedProductDraft = {
  id: string
  name: string
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
  'emailNotificationsEnabled',
] as const

const DIMENSION_TARGET_TYPES = ['class', 'department', 'location', 'customer', 'vendor']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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

function mappingDraftKey(sourceKind: string, sourceId: string) {
  return `${sourceKind}:${sourceId}`
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
    classification: text(value.classification),
    accountType: text(value.accountType),
    itemType: text(value.itemType),
  }
}

function profilePayload(profile: DataRecord) {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field, profile[field]]))
}

function mappingPayload(mapping: MappingDraft) {
  return {
    sourceKind: mapping.sourceKind,
    sourceId: mapping.sourceId,
    sourceName: mapping.sourceName,
    targetType: mapping.targetType,
    targetId: mapping.targetId,
    targetName: mapping.targetName,
    active: mapping.active,
  }
}

function mappingFromSource(source: DataRecord, current: DataRecord | undefined): MappingDraft {
  const sourceKind = text(source.sourceKind)
  const suggestedTarget = record(source.suggestedTarget)
  const hasCurrent = Boolean(current)
  const currentIsUsable = Boolean(
    current
      && current.active !== false
      && ['valid', 'unvalidated'].includes(text(current.validationStatus, 'unvalidated')),
  )
  const suggested = !hasCurrent && Boolean(suggestedTarget.id)
  return {
    sourceKind,
    sourceId: text(source.sourceId),
    sourceName: text(source.sourceName, 'POS source'),
    targetType: targetTypeFor(sourceKind, text(current?.targetType)),
    targetId: text(current?.targetId || suggestedTarget.id),
    targetName: text(current?.targetName || suggestedTarget.name),
    active: hasCurrent ? currentIsUsable : suggested,
    suggested,
    suggestionConfidence: suggested ? text(suggestedTarget.confidence, 'normalized') : '',
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
  const [scope, setScope] = useState<MappingScope>('organization_default')
  const [mappingDrafts, setMappingDrafts] = useState<MappingDraft[]>([])
  const [dirtyMappingKeys, setDirtyMappingKeys] = useState<Set<string>>(() => new Set())
  const [targetInputBySource, setTargetInputBySource] = useState<Record<string, string>>({})
  const [mappingError, setMappingError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingMappings, setSavingMappings] = useState(false)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [refreshingQuickBooks, setRefreshingQuickBooks] = useState(false)
  const [runningAccountingCommand, setRunningAccountingCommand] = useState<'reload-sales' | 'regenerate-accounting' | null>(null)
  const [preparingProduct, setPreparingProduct] = useState(false)
  const [productDraft, setProductDraft] = useState<ProductDraft | null>(null)
  const [preparedProductDraft, setPreparedProductDraft] = useState<PreparedProductDraft | null>(null)
  const [preparedProductDraftDialogOpen, setPreparedProductDraftDialogOpen] = useState(false)
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
        setScope(nextCapabilities.canManage === true && text(effectiveProfile.scope) !== 'location_override'
          ? 'organization_default'
          : 'location_override')
        setMappingDrafts(rows(next.sourceCatalog).map((source) => (
          mappingFromSource(source, currentBySource.get(`${text(source.sourceKind)}:${text(source.sourceId)}`))
        )))
        setDirtyMappingKeys(new Set())
        setTargetInputBySource({})
        setMappingError(null)
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
  const currentDraft = record(workspace?.draft)
  const draftHistory = rows(workspace?.draftHistory)
  const latestCommand = record(workspace?.latestCommand)
  const sourceCatalog = rows(workspace?.sourceCatalog)
  const missingMappings = rows(readiness.missingMappings)
  const commandStatus = text(latestCommand.status)
  const commandActive = ['queued', 'running'].includes(commandStatus)
  const hasAccountingDraft = Boolean(currentDraft.id)
  const protectedRevisionCount = draftHistory.filter((draft) => (
    ['approved', 'posting', 'posted'].includes(text(draft.status))
  )).length

  useEffect(() => {
    if (!commandActive) return
    const timer = window.setTimeout(() => setReload((value) => value + 1), 2500)
    return () => window.clearTimeout(timer)
  }, [commandActive, latestCommand.id, latestCommand.updatedAt])

  const targetOptions = useMemo(() => {
    const make = (value: unknown) => rows(value).map((entry) => option(entry)).filter((entry) => entry.id)
    return {
      account: make(targets.accounts),
      item: make(targets.items).filter((entry) => entry.itemType.toLowerCase() !== 'category'),
      customer: make(targets.customers),
      vendor: make(targets.vendors),
      tax_code: make(targets.taxCodes),
      class: make(targets.classes),
      department: make(targets.departments),
      location: make(targets.locations),
    } as Record<string, TargetOption[]>
  }, [targets])

  const quickBooksCategories = useMemo(() => rows(targets.items)
    .map((entry) => option(entry))
    .filter((entry) => entry.id && entry.itemType.toLowerCase() === 'category'), [targets.items])

  const incomeAccounts = useMemo(() => targetOptions.account.filter((entry) => (
    entry.classification === 'Revenue' || /income|sales/i.test(`${entry.accountType} ${entry.name}`)
  )), [targetOptions.account])
  const expenseAccounts = useMemo(() => targetOptions.account.filter((entry) => (
    entry.classification === 'Expense' || /expense|cost of goods sold/i.test(`${entry.accountType} ${entry.name}`)
  )), [targetOptions.account])

  const sourceByKey = useMemo(() => new Map(sourceCatalog.map((source) => [
    `${text(source.sourceKind)}:${text(source.sourceId)}`,
    source,
  ])), [sourceCatalog])

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
    const key = mappingDraftKey(sourceKind, sourceId)
    setMappingDrafts((current) => current.map((entry) => (
      entry.sourceKind === sourceKind && entry.sourceId === sourceId
        ? { ...entry, ...patch, suggested: patch.suggested ?? false, suggestionConfidence: patch.suggestionConfidence ?? '' }
        : entry
    )))
    setDirtyMappingKeys((current) => new Set(current).add(key))
    setMappingError(null)
  }

  function openProductDraft(mapping: MappingDraft) {
    const source = sourceByKey.get(`${mapping.sourceKind}:${mapping.sourceId}`)
    const catalogOrigin = text(source?.catalogOrigin)
    if (
      mapping.sourceKind !== 'sales_item'
      || !UUID_PATTERN.test(mapping.sourceId)
      || !locationGuid
      || !['menu', 'observed_and_menu'].includes(catalogOrigin)
    ) {
      setError('Select an exact Toast menu item before preparing a mapped QuickBooks product.')
      return
    }
    const suggestion = record(source?.productCreationSuggestion)
    const preferredIncomeAccount = incomeAccounts.find((entry) => /sales of product income/i.test(entry.name))
      || incomeAccounts.find((entry) => /sales|food|beverage/i.test(entry.name))
      || (incomeAccounts.length === 1 ? incomeAccounts[0] : null)
    setProductDraft({
      clientRequestId: globalThis.crypto.randomUUID(),
      sourceKind: 'sales_item',
      sourceId: mapping.sourceId,
      sourceRestaurantGuid: locationGuid,
      mappingScope: scope,
      name: text(suggestion.name, mapping.sourceName),
      itemType: text(suggestion.itemType) === 'Service' ? 'Service' : 'NonInventory',
      sku: text(suggestion.sku),
      description: text(suggestion.description, 'Toast menu item prepared by ClawPilot'),
      unitPrice: String(amount(suggestion.unitPrice) || ''),
      purchaseCost: String(amount(suggestion.purchaseCost) || ''),
      incomeAccountId: preferredIncomeAccount?.id || '',
      expenseAccountId: '',
      parentCategoryId: '',
      taxable: suggestion.taxable !== false,
    })
    setPreparedProductDraft(null)
    setPreparedProductDraftDialogOpen(false)
    setError(null)
  }

  function updateProductDraft(patch: Partial<ProductDraft>) {
    setProductDraft((current) => current ? { ...current, ...patch } : current)
  }

  function reviewPreparedProductDraft(prepared: PreparedProductDraft) {
    setPreparedProductDraftDialogOpen(false)
    const oldURL = window.location.href
    const nextURL = buildAccountingDraftReviewUrl(oldURL, prepared.id)
    window.history.pushState({}, '', `${nextURL.pathname}${nextURL.search}${nextURL.hash}`)
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: nextURL.toString() }))
  }

  async function prepareQuickBooksProduct() {
    if (!productDraft) return
    setPreparingProduct(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/accounting/quickbooks/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: productDraft.clientRequestId,
          operationKind: 'item.create',
          payload: {
            name: productDraft.name,
            itemType: productDraft.itemType,
            sku: productDraft.sku,
            description: productDraft.description,
            unitPrice: productDraft.unitPrice,
            purchaseCost: productDraft.purchaseCost,
            incomeAccountId: productDraft.incomeAccountId,
            expenseAccountId: productDraft.expenseAccountId,
            parentCategoryId: productDraft.parentCategoryId,
            taxable: productDraft.taxable,
            sourceKind: productDraft.sourceKind,
            sourceId: productDraft.sourceId,
            sourceRestaurantGuid: productDraft.sourceRestaurantGuid,
            mappingScope: productDraft.mappingScope,
          },
        }),
      })
      const payload = await response.json().catch(() => ({})) as DataRecord
      if (!response.ok || payload.ok !== true) throw new Error(text(payload.error, 'QuickBooks product draft could not be prepared'))
      const requestId = text(record(payload.request).id)
      if (!requestId) throw new Error('QuickBooks product draft was prepared without a review reference')
      const prepared = { id: requestId, name: productDraft.name }
      setProductDraft(null)
      setPreparedProductDraft(prepared)
      setPreparedProductDraftDialogOpen(true)
      setNotice('QuickBooks product draft prepared. Review and approve it before the product is created.')
    } catch (saveError) {
      setError((saveError as Error).message)
    } finally {
      setPreparingProduct(false)
    }
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
    setMappingError(null)
    setNotice(null)
    try {
      const changedMappings = mappingDrafts.filter((entry) => (
        dirtyMappingKeys.has(mappingDraftKey(entry.sourceKind, entry.sourceId))
      ))
      if (!changedMappings.length) throw new Error('Select or change a QuickBooks target before saving mappings.')
      const unresolved = changedMappings.find((entry) => {
        const typedLabel = text(targetInputBySource[mappingDraftKey(entry.sourceKind, entry.sourceId)])
        return !entry.targetId || !entry.targetName || (typedLabel && typedLabel !== entry.targetName)
      })
      if (unresolved) {
        throw new Error(`Select a QuickBooks target from the list for "${unresolved.sourceName}" before saving.`)
      }
      const mappings = changedMappings.map(mappingPayload)
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
      if (!response.ok || payload.ok !== true) {
        const code = text(payload.code)
        const message = text(payload.error, 'Accounting mappings could not be saved')
        throw new Error(code ? `${message} (${code})` : message)
      }
      const savedMappings = rows(payload.mappings)
      const unconfirmed = mappings.find((expected) => !savedMappings.some((saved) => (
        text(saved.sourceKind) === expected.sourceKind
        && text(saved.sourceId) === expected.sourceId
        && text(saved.targetType) === expected.targetType
        && text(saved.targetId) === expected.targetId
        && text(saved.targetName) === expected.targetName
        && saved.active === expected.active
        && ['valid', 'unvalidated'].includes(text(saved.validationStatus, 'unvalidated'))
      )))
      if (unconfirmed) {
        const returned = savedMappings.find((saved) => (
          text(saved.sourceKind) === unconfirmed.sourceKind && text(saved.sourceId) === unconfirmed.sourceId
        ))
        const validationStatus = text(returned?.validationStatus)
        throw new Error(validationStatus
          ? `The mapping for "${unconfirmed.sourceName}" was not activated (${validationStatus.replaceAll('_', ' ')}). Refresh the Toast and QuickBooks catalogs, then try again.`
          : `The mapping for "${unconfirmed.sourceName}" was not confirmed by the server. Refresh the catalogs, then try again.`)
      }
      const changedCount = Number(payload.changedCount)
      setNotice(changedCount > 0
        ? `${changedCount} accounting ${changedCount === 1 ? 'mapping' : 'mappings'} saved as a new revision.`
        : 'The selected accounting mappings were already current.')
      setReload((value) => value + 1)
    } catch (saveError) {
      setMappingError((saveError as Error).message)
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

  async function runAccountingCommand(action: 'reload-sales' | 'regenerate-accounting') {
    setRunningAccountingCommand(action)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/pos/accounting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, restaurantGuid: locationGuid, businessDate }),
      })
      const payload = await response.json().catch(() => ({})) as DataRecord
      if (!response.ok || payload.ok !== true) {
        throw new Error(text(payload.error, action === 'reload-sales'
          ? 'Toast sales could not be reloaded'
          : 'POS accounting could not be regenerated'))
      }
      setNotice(action === 'reload-sales'
        ? `Toast sales reload queued for ${businessDate}. Accounting regenerates after every required sales source finishes.`
        : `POS accounting regenerated from stored sales for ${businessDate}.`)
      setReload((value) => value + 1)
    } catch (commandError) {
      setError((commandError as Error).message)
    } finally {
      setRunningAccountingCommand(null)
    }
  }

  if (loading && !workspace) {
    return <Box minHeight={220} display="grid" sx={{ placeItems: 'center' }}><CircularProgress size={28} /></Box>
  }

  return (
    <Stack spacing={2}>
      {error ? <Alert severity="error" sx={{ borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? (
        <Alert
          severity="success"
          onClose={() => setNotice(null)}
          action={preparedProductDraft ? <Button color="inherit" size="small" onClick={() => reviewPreparedProductDraft(preparedProductDraft)}>Review draft</Button> : undefined}
          sx={{ borderRadius: '8px' }}
        >
          {notice}
        </Alert>
      ) : null}

      <Box sx={{ ...panelSx, p: { xs: 1.5, sm: 2 } }}>
        <Box display="flex" flexDirection={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', md: 'center' }} gap={1.5}>
          <Box minWidth={0}>
            <Box display="flex" alignItems="center" gap={0.75} flexWrap="wrap">
              <Typography fontWeight={700}>Date accounting controls</Typography>
              <Chip size="small" variant="outlined" label={businessDate} />
              {currentDraft.id ? <Chip size="small" variant="outlined" label={`Draft revision ${number(amount(currentDraft.draftRevision))}`} /> : null}
              {currentDraft.status ? <Chip size="small" variant="outlined" label={text(currentDraft.status).replaceAll('_', ' ')} /> : null}
            </Box>
            <Typography variant="caption" color="text.secondary" display="block" mt={0.4}>
              {text(locationRecord.locationName || locationRecord.restaurantName, 'Selected Toast location')}
            </Typography>
          </Box>
          <Box display="flex" gap={1} flexWrap="wrap">
            <Tooltip title="Fetch this location and business date from Toast, replace the normalized date projection, then regenerate accounting">
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={runningAccountingCommand === 'reload-sales' || (commandActive && text(latestCommand.commandType) === 'reload_sales') ? <CircularProgress size={16} /> : <RefreshRounded />}
                  onClick={() => runAccountingCommand('reload-sales')}
                  disabled={capabilities.canPrepare !== true || !locationGuid || commandActive || runningAccountingCommand !== null}
                >
                  Reload sales
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Create a new accounting revision from stored sales and the current profile and mappings without contacting Toast">
              <span>
                <Button
                  variant="contained"
                  size="small"
                  startIcon={runningAccountingCommand === 'regenerate-accounting' ? <CircularProgress size={16} /> : <AccountBalanceRounded />}
                  onClick={() => runAccountingCommand('regenerate-accounting')}
                  disabled={capabilities.canPrepare !== true || !locationGuid || commandActive || runningAccountingCommand !== null}
                >
                  Regenerate accounting
                </Button>
              </span>
            </Tooltip>
          </Box>
        </Box>
        {latestCommand.id ? (
          <Box display="flex" gap={0.75} alignItems="center" flexWrap="wrap" mt={1.25}>
            <Chip
              size="small"
              color={commandStatus === 'failed' ? 'error' : commandStatus === 'succeeded' ? 'success' : 'info'}
              variant="outlined"
              label={`${text(latestCommand.commandType).replaceAll('_', ' ')}: ${commandStatus}`}
            />
            {latestCommand.resultDraftRevision ? <Typography variant="caption" color="text.secondary">Revision {number(amount(latestCommand.resultDraftRevision))}</Typography> : null}
            {latestCommand.completedAt ? <Typography variant="caption" color="text.disabled">Completed {new Date(text(latestCommand.completedAt)).toLocaleString()}</Typography> : null}
          </Box>
        ) : null}
        {commandStatus === 'failed' && latestCommand.lastError ? <Alert severity="error" sx={{ mt: 1.25, borderRadius: '8px' }}>{text(latestCommand.lastError)}</Alert> : null}
        {protectedRevisionCount > 0 ? (
          <Alert severity="info" variant="outlined" sx={{ mt: 1.25, borderRadius: '8px' }}>
            {number(protectedRevisionCount)} approved, posting, or posted revision{protectedRevisionCount === 1 ? '' : 's'} retained as immutable evidence.
          </Alert>
        ) : null}
      </Box>

      <Dialog
        open={Boolean(preparedProductDraft) && preparedProductDraftDialogOpen}
        onClose={() => setPreparedProductDraftDialogOpen(false)}
        fullWidth
        maxWidth="xs"
        PaperProps={{ sx: { borderRadius: '8px' } }}
      >
        <DialogTitle>Product draft prepared</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} pt={0.5}>
            <Box display="flex" alignItems="center" gap={1}>
              <CheckCircleRounded color="success" />
              <Typography fontWeight={700}>{preparedProductDraft?.name}</Typography>
            </Box>
            <Alert severity="info" variant="outlined">
              QuickBooks has not been changed yet. Review and submit this draft from Accounting Actions, then approve it before posting.
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreparedProductDraftDialogOpen(false)}>Later</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (preparedProductDraft) reviewPreparedProductDraft(preparedProductDraft)
            }}
          >
            Review draft
          </Button>
        </DialogActions>
      </Dialog>

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
          <TextField select label="Configuration scope" value={scope} onChange={(event) => setScope(event.target.value as MappingScope)} size="small" sx={controlSx} disabled={capabilities.canManage !== true}>
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
          <Tooltip title="Email verified organization owners and accounting administrators when a new issue is detected. Existing historical issues are not backfilled.">
            <FormControlLabel
              control={(
                <Switch
                  checked={profile.emailNotificationsEnabled === true}
                  onChange={(event) => updateProfile('emailNotificationsEnabled', event.target.checked)}
                  disabled={capabilities.canManage !== true}
                />
              )}
              label="Email issue alerts"
            />
          </Tooltip>
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
            <Button variant="outlined" size="small" startIcon={savingMappings ? <CircularProgress size={16} /> : <SaveRounded />} onClick={saveMappings} disabled={!canEdit || savingMappings || dirtyMappingKeys.size === 0}>
              Save
            </Button>
          </Box>
        </Box>
        {mappingError ? <Alert severity="error" onClose={() => setMappingError(null)} sx={{ mx: { xs: 1.5, sm: 2 }, mb: 1.5 }}>{mappingError}</Alert> : null}
        {visibleMappings.map((mapping) => {
          const options = targetOptions[mapping.targetType] || []
          const source = sourceByKey.get(`${mapping.sourceKind}:${mapping.sourceId}`)
          const sourceKey = mappingDraftKey(mapping.sourceKind, mapping.sourceId)
          const exactToastProductSource = mapping.sourceKind === 'sales_item'
            && UUID_PATTERN.test(mapping.sourceId)
            && ['menu', 'observed_and_menu'].includes(text(source?.catalogOrigin))
          const productSuggestion = exactToastProductSource ? record(source?.productCreationSuggestion) : {}
          const selected: TargetOption | null = mapping.active
            ? options.find((entry) => entry.id === mapping.targetId)
              || (mapping.targetId ? {
                id: mapping.targetId,
                name: mapping.targetName || mapping.targetId,
                detail: 'Saved target',
                classification: '',
                accountType: '',
                itemType: '',
              } : null)
            : null
          return (
            <Box key={`${mapping.sourceKind}:${mapping.sourceId}`} px={{ xs: 1.5, sm: 2 }} py={1.25} borderTop="1px solid rgba(255,255,255,0.065)" display="grid" gridTemplateColumns={{ xs: '1fr', md: 'minmax(180px, 0.8fr) 150px minmax(240px, 1.2fr)' }} gap={1.25} alignItems="center">
              <Box minWidth={0}>
                <Box display="flex" gap={0.6} alignItems="center" minWidth={0}>
                  <Typography variant="body2" fontWeight={650} noWrap>{mapping.sourceName}</Typography>
                  {mapping.suggested ? <Chip size="small" color="info" variant="outlined" label="Suggested" /> : null}
                  {text(source?.catalogOrigin) === 'menu' ? <Chip size="small" variant="outlined" label="Menu" /> : null}
                </Box>
                <Typography variant="caption" color="text.secondary" display="block" noWrap>
                  {mapping.sourceKind.replaceAll('_', ' ')}{mapping.suggested ? ` | ${mapping.suggestionConfidence} name match` : ''}
                </Typography>
              </Box>
              <TextField
                select
                label="Target type"
                size="small"
                value={mapping.targetType}
                onChange={(event) => {
                  setTargetInputBySource((current) => ({ ...current, [sourceKey]: '' }))
                  updateMapping(mapping.sourceKind, mapping.sourceId, {
                    targetType: event.target.value,
                    targetId: '',
                    targetName: '',
                    active: false,
                  })
                }}
                disabled={!canEdit || targetTypesFor(mapping.sourceKind).length === 1}
                sx={controlSx}
              >
                {targetTypesFor(mapping.sourceKind).map((entry) => <MenuItem key={entry} value={entry}>{entry.replaceAll('_', ' ')}</MenuItem>)}
              </TextField>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75} alignItems={{ xs: 'stretch', sm: 'center' }}>
                <Autocomplete
                  options={options}
                  value={selected}
                  inputValue={targetInputBySource[sourceKey] ?? selected?.name ?? ''}
                  getOptionLabel={(entry) => entry.name}
                  isOptionEqualToValue={(left, right) => left.id === right.id}
                  onInputChange={(_, value, reason) => {
                    setTargetInputBySource((current) => ({ ...current, [sourceKey]: value }))
                    if (reason === 'input' && value !== selected?.name) {
                      updateMapping(mapping.sourceKind, mapping.sourceId, { targetId: '', targetName: '', active: false })
                    } else if (reason === 'clear') {
                      updateMapping(mapping.sourceKind, mapping.sourceId, { active: false })
                    }
                  }}
                  onChange={(_, value, reason) => {
                    setTargetInputBySource((current) => ({ ...current, [sourceKey]: value?.name || '' }))
                    updateMapping(mapping.sourceKind, mapping.sourceId, value
                      ? { targetId: value.id, targetName: value.name, active: true }
                      : reason === 'clear'
                        ? { active: false }
                        : { targetId: '', targetName: '', active: false })
                  }}
                  disabled={!canEdit || !options.length}
                  sx={{ flex: 1, minWidth: 0 }}
                  renderInput={(params) => <TextField {...params} label={options.length ? 'QuickBooks target' : 'Refresh QuickBooks catalog'} size="small" sx={controlSx} />}
                />
                {Object.keys(productSuggestion).length ? (
                  <Tooltip title="Prepare a reviewable QuickBooks product draft using this Toast menu item">
                    <span>
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<AddRounded />}
                        onClick={() => openProductDraft(mapping)}
                        disabled={capabilities.canPrepare !== true || quickBooks.bound !== true}
                        sx={{ whiteSpace: 'nowrap', minHeight: 40 }}
                      >
                        Product
                      </Button>
                    </span>
                  </Tooltip>
                ) : null}
              </Stack>
            </Box>
          )
        })}
        {!visibleMappings.length ? <Typography variant="body2" color="text.secondary" px={2} py={2}>{search ? 'No mappings match this search.' : 'No Toast sources are available yet.'}</Typography> : null}
      </Box>

      {hasAccountingDraft ? (
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
                This screen prepares and validates accounting evidence. Review the completed draft in Accounting &gt; POS posting parity to record a Shogo result or post the Sales Receipt and Journal Entry with ClawPilot.
              </Alert>
            </Stack>
          </Box>
        </Box>
      ) : (
        <Alert severity="info" sx={{ borderRadius: '8px' }}>
          No sales-backed accounting draft is available in this date range. Posting configuration remains available.
        </Alert>
      )}

      <Dialog
        open={Boolean(productDraft)}
        onClose={() => { if (!preparingProduct) setProductDraft(null) }}
        fullWidth
        maxWidth="sm"
        PaperProps={{ sx: { borderRadius: '8px', bgcolor: '#171821', backgroundImage: 'none' } }}
      >
        <DialogTitle>Prepare QuickBooks product</DialogTitle>
        <DialogContent dividers>
          {productDraft ? (
            <Stack spacing={1.5} pt={0.5}>
              <Alert severity="info" sx={{ borderRadius: '8px' }}>
                This creates an immutable draft only. The product is not added to QuickBooks until an authorized user reviews and approves it.
              </Alert>
              <TextField label="Product name" value={productDraft.name} onChange={(event) => updateProductDraft({ name: event.target.value })} required sx={controlSx} />
              <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: '1fr 1fr' }} gap={1.25}>
                <TextField select label="Product type" value={productDraft.itemType} onChange={(event) => updateProductDraft({ itemType: event.target.value as ProductDraft['itemType'] })} sx={controlSx}>
                  <MenuItem value="NonInventory">Non-inventory</MenuItem>
                  <MenuItem value="Service">Service</MenuItem>
                </TextField>
                <TextField label="SKU (optional)" value={productDraft.sku} onChange={(event) => updateProductDraft({ sku: event.target.value })} sx={controlSx} />
                <TextField label="Sales price" type="number" inputProps={{ min: 0, step: '0.01' }} value={productDraft.unitPrice} onChange={(event) => updateProductDraft({ unitPrice: event.target.value })} sx={controlSx} />
                <TextField label="Purchase cost" type="number" inputProps={{ min: 0, step: '0.01' }} value={productDraft.purchaseCost} onChange={(event) => updateProductDraft({ purchaseCost: event.target.value })} sx={controlSx} />
              </Box>
              <Autocomplete
                options={quickBooksCategories}
                value={quickBooksCategories.find((entry) => entry.id === productDraft.parentCategoryId) || null}
                getOptionLabel={(entry) => entry.name}
                isOptionEqualToValue={(left, right) => left.id === right.id}
                onChange={(_, value) => updateProductDraft({ parentCategoryId: value?.id || '' })}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="QuickBooks category (optional)"
                    helperText="Nested category paths use QuickBooks names such as Breakfast:Breakfast Sandwiches."
                    sx={controlSx}
                  />
                )}
              />
              <Autocomplete
                options={incomeAccounts}
                value={incomeAccounts.find((entry) => entry.id === productDraft.incomeAccountId) || null}
                getOptionLabel={(entry) => entry.name}
                isOptionEqualToValue={(left, right) => left.id === right.id}
                onChange={(_, value) => updateProductDraft({ incomeAccountId: value?.id || '' })}
                renderInput={(params) => <TextField {...params} label="Income account" required sx={controlSx} />}
              />
              <Autocomplete
                options={expenseAccounts}
                value={expenseAccounts.find((entry) => entry.id === productDraft.expenseAccountId) || null}
                getOptionLabel={(entry) => entry.name}
                isOptionEqualToValue={(left, right) => left.id === right.id}
                onChange={(_, value) => updateProductDraft({ expenseAccountId: value?.id || '' })}
                renderInput={(params) => <TextField {...params} label="Expense account (optional)" sx={controlSx} />}
              />
              <TextField label="Description" value={productDraft.description} onChange={(event) => updateProductDraft({ description: event.target.value })} multiline minRows={2} sx={controlSx} />
              <FormControlLabel control={<Switch checked={productDraft.taxable} onChange={(event) => updateProductDraft({ taxable: event.target.checked })} />} label="Taxable" />
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setProductDraft(null)} disabled={preparingProduct}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={preparingProduct ? <CircularProgress size={16} /> : <AddRounded />}
            onClick={() => { void prepareQuickBooksProduct() }}
            disabled={preparingProduct || !productDraft?.name.trim() || !productDraft?.incomeAccountId}
          >
            Prepare draft
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
