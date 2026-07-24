'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded'
import PointOfSaleRounded from '@mui/icons-material/PointOfSaleRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'
import PosAccountingPanel, { type PosAccountingFocusAction } from '@/components/pos/PosAccountingPanel'
import PosGuideDialog from '@/components/pos/PosGuideDialog'
import PosReportsPanel from '@/components/pos/PosReportsPanel'
import { buildPosPostingReviewUrl } from '@/lib/accountingDraftNavigation'
import { isDemoWorkspaceId } from '@/lib/demoMode'

type PosView = 'overview' | 'orders' | 'reports' | 'accounting'
type DataRecord = Record<string, unknown>
type ChipTone = 'default' | 'success' | 'warning' | 'error' | 'info'

type PosCapabilities = {
  canView: boolean
  canManage: boolean
}

type PostingQueueStatus = 'Hold' | 'Ready' | 'Posting' | 'Posted' | 'Failed'

type AffectedCheck = {
  orderGuid: string
  checkGuid: string
  displayNumber: string
}

type PostingQueueBlocker = {
  key: string
  title: string
  detail: string
  actionKind: PosAccountingFocusAction['kind']
  sourceKind: string
  sourceId: string
  sourceName: string
  affectedChecks: AffectedCheck[]
  affectedCheckCount: number
}

type PostingQueueDraft = {
  draft: DataRecord
  key: string
  status: PostingQueueStatus
  statusLabel: string
  blockers: PostingQueueBlocker[]
}

type PosLocation = {
  id: string
  name: string
  code: string
  timezone: string
  testMode: boolean
  raw: DataRecord
}

type PosSnapshot = {
  organizationId: string
  range: DataRecord
  locations: PosLocation[]
  summary: DataRecord
  daily: DataRecord[]
  orders: {
    items: DataRecord[]
    total: number
    page: number
    pageSize: number
  }
  selectedOrder: DataRecord | null
  drafts: unknown
  accountingIssues: DataRecord[]
  syncIssues: DataRecord[]
  readiness: DataRecord
}

type PosPayload = {
  ok?: boolean
  error?: string
  capabilities?: Partial<PosCapabilities>
  pos?: unknown
}

const panelSx = {
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '8px',
  backgroundColor: '#15151D',
}

const controlSx = {
  minWidth: 0,
  '& .MuiInputBase-root': {
    height: 40,
    borderRadius: '8px',
    backgroundColor: '#15151D',
  },
  '& input': { minWidth: 0 },
}

function record(value: unknown): DataRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DataRecord : {}
}

function recordList(value: unknown): DataRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : []
}

function firstValue(source: DataRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== null && value !== undefined && value !== '') return value
  }
  return undefined
}

function scalarText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  const nested = record(value)
  const candidate = firstValue(nested, ['name', 'displayName', 'label', 'value', 'description'])
  return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate).trim() : ''
}

function textValue(source: DataRecord, keys: string[], fallback = ''): string {
  return scalarText(firstValue(source, keys)) || fallback
}

function numberValue(source: DataRecord, keys: string[], fallback = 0): number {
  const parsed = Number(firstValue(source, keys))
  return Number.isFinite(parsed) ? parsed : fallback
}

function booleanValue(source: DataRecord, keys: string[]): boolean | undefined {
  const value = firstValue(source, keys)
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return undefined
}

function localDate(daysFromToday: number) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + daysFromToday)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeLocation(value: unknown, index: number): PosLocation {
  const source = record(value)
  const id = textValue(source, ['restaurantGuid', 'locationGuid', 'guid', 'id'])
  const restaurantName = textValue(source, ['restaurantName', 'name'], `Location ${index + 1}`)
  const locationName = textValue(source, ['locationName'])
  return {
    id,
    name: locationName && locationName !== restaurantName ? `${locationName} · ${restaurantName}` : locationName || restaurantName,
    code: textValue(source, ['locationCode', 'code']),
    timezone: textValue(source, ['timezone', 'timeZone']),
    testMode: booleanValue(source, ['testMode', 'isTest']) === true,
    raw: source,
  }
}

function normalizeSnapshot(value: unknown): PosSnapshot {
  const source = record(value)
  const orders = record(source.orders)
  return {
    organizationId: textValue(source, ['organizationId']),
    range: record(source.range),
    locations: (Array.isArray(source.locations) ? source.locations : []).map(normalizeLocation),
    summary: record(source.summary),
    daily: recordList(source.daily),
    orders: {
      items: recordList(orders.items),
      total: Math.max(0, Math.round(numberValue(orders, ['total']))),
      page: Math.max(1, Math.round(numberValue(orders, ['page'], 1))),
      pageSize: Math.max(1, Math.round(numberValue(orders, ['pageSize'], 25))),
    },
    selectedOrder: Object.keys(record(source.selectedOrder)).length ? record(source.selectedOrder) : null,
    drafts: source.drafts,
    accountingIssues: recordList(source.accountingIssues),
    syncIssues: recordList(source.syncIssues),
    readiness: record(source.readiness),
  }
}

function statusTone(status: string): ChipTone {
  if (/paid|posted|ready|complete|connected|reconciled|success|approved/i.test(status)) return 'success'
  if (/failed|error|void|declined|blocked|missing/i.test(status)) return 'error'
  if (/pending|partial|open|review|mapping|stale|waiting|processing|posting|hold|queued|awaiting|out of balance|update/i.test(status)) return 'warning'
  return 'default'
}

function displayStatus(value: string) {
  const normalized = value.replace(/[_-]+/g, ' ').trim()
  return normalized ? normalized.replace(/\b\w/g, (character) => character.toUpperCase()) : 'Unknown'
}

function orderId(order: DataRecord) {
  return textValue(order, ['guid', 'orderGuid', 'id', 'externalId'])
}

function orderLabel(order: DataRecord) {
  const label = textValue(order, ['displayNumber', 'orderNumber', 'checkNumber', 'externalId'])
  const id = orderId(order)
  return label ? `Order ${label}` : id ? `Order ${id.slice(-8)}` : 'Order detail'
}

function orderStatus(order: DataRecord) {
  if (booleanValue(order, ['voided', 'isVoided']) === true) return 'Voided'
  if (booleanValue(order, ['deleted', 'isDeleted']) === true) return 'Deleted'
  return displayStatus(textValue(order, ['status', 'paymentStatus', 'approvalStatus', 'state'], 'Open'))
}

function dateOnlyValue(value: unknown) {
  const candidate = scalarText(value)
  const match = candidate.match(/^\d{4}-\d{2}-\d{2}/)
  return match?.[0] || ''
}

function orderFulfillmentDate(order: DataRecord) {
  return dateOnlyValue(firstValue(order, ['fulfillmentBusinessDate', 'promisedAt', 'estimatedFulfillmentAt']))
}

function orderPaymentDates(order: DataRecord) {
  const dates = Array.isArray(order.paymentBusinessDates)
    ? order.paymentBusinessDates.map(dateOnlyValue).filter(Boolean)
    : []
  const paidAt = dateOnlyValue(firstValue(order, ['paidAt', 'paidDate']))
  return [...new Set(dates.length ? dates : paidAt ? [paidAt] : [])]
}

function isPreorder(order: DataRecord) {
  const fulfillmentDate = orderFulfillmentDate(order)
  const paymentDates = orderPaymentDates(order)
  return Boolean(fulfillmentDate && paymentDates.some((paymentDate) => paymentDate !== fulfillmentDate))
}

function orderChecks(order: DataRecord): DataRecord[] {
  const directChecks = recordList(firstValue(order, ['checks']))
  const checks = directChecks.length
    ? directChecks
    : recordList(firstValue(record(firstValue(order, ['details'])), ['checks']))
  if (checks.length) return checks
  const items = recordList(firstValue(order, ['items', 'selections']))
  const payments = recordList(firstValue(order, ['payments']))
  return items.length || payments.length ? [{ ...order, items, payments }] : []
}

function itemName(item: DataRecord) {
  const nestedItem = record(firstValue(item, ['item', 'menuItem']))
  return textValue(item, ['displayName', 'itemName', 'name'], textValue(nestedItem, ['name', 'displayName'], 'Item'))
}

function readinessEntry(readiness: DataRecord, keys: string[]) {
  const raw = firstValue(readiness, keys)
  if (typeof raw === 'boolean') return { label: raw ? 'Ready' : 'Waiting', tone: raw ? 'success' : 'warning' as ChipTone, detail: '' }
  if (typeof raw === 'string') return { label: displayStatus(raw), tone: statusTone(raw), detail: '' }
  const source = record(raw)
  const ready = booleanValue(source, ['ready', 'available', 'complete', 'configured'])
  const status = textValue(source, ['status', 'state'])
  const detail = textValue(source, ['message', 'detail', 'reason'])
  if (status) return { label: displayStatus(status), tone: statusTone(status), detail }
  if (ready !== undefined) return { label: ready ? 'Ready' : 'Waiting', tone: ready ? 'success' : 'warning' as ChipTone, detail }
  return { label: 'Not reported', tone: 'default' as ChipTone, detail }
}

function draftItems(value: unknown) {
  if (Array.isArray(value)) return recordList(value)
  const source = record(value)
  return recordList(firstValue(source, ['items', 'rows', 'drafts']))
}

function affectedChecks(value: unknown): AffectedCheck[] {
  const candidates = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  return candidates.flatMap((candidate) => {
    if (typeof candidate === 'number') return []
    if (typeof candidate === 'string') {
      const displayNumber = String(candidate).trim()
      return displayNumber ? [{ orderGuid: '', checkGuid: '', displayNumber }] : []
    }
    const source = record(candidate)
    const order = record(firstValue(source, ['order']))
    const check = record(firstValue(source, ['check']))
    const orderGuid = textValue(
      source,
      ['orderGuid', 'orderId', 'order_guid'],
      textValue(order, ['guid', 'orderGuid', 'id']),
    )
    const checkGuid = textValue(
      source,
      ['checkGuid', 'checkId', 'check_guid'],
      textValue(check, ['guid', 'checkGuid', 'id']),
    )
    const displayNumber = textValue(
      source,
      ['displayNumber', 'checkNumber', 'orderNumber', 'reference'],
      textValue(check, ['displayNumber', 'checkNumber']),
    )
    return orderGuid || checkGuid || displayNumber ? [{ orderGuid, checkGuid, displayNumber }] : []
  })
}

function affectedCheckCount(value: unknown, checks: AffectedCheck[]) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : checks.length
}

function blockerActionKind(source: DataRecord, sourceKind: string, title: string, detail: string): PosAccountingFocusAction['kind'] {
  const explicit = textValue(source, ['actionKind', 'actionType', 'target', 'action']).toLowerCase()
  if (/mapping|map/.test(explicit) || sourceKind) return 'mapping'
  if (/check|order/.test(explicit)) return 'checks'
  if (/review posting|review failure|retry/.test(explicit)) return 'posting_review'
  if (/reload|recheck/.test(explicit)) return 'reload'
  if (/config|profile|quickbooks/.test(explicit)) return 'configuration'
  const content = `${title} ${detail}`.toLowerCase()
  if (/open check|affected check|payment exception|pre.?order/.test(content)) return 'checks'
  if (/quickbooks company|company bound|clearing account|profile/.test(content)) return 'configuration'
  if (/protected posting|failed accounting post|failed posting|provider failure/.test(content)) return 'posting_review'
  if (/reload|source reconciliation|source variance/.test(content)) return 'reload'
  return 'preview'
}

function postingStatusLabel(rawStatus: string, canonicalStatus: PostingQueueStatus) {
  const normalized = rawStatus.replace(/[\s_-]+/g, '').toLowerCase()
  const labels: Record<string, string> = {
    empty: 'Inactive',
    none: 'Inactive',
    post: 'Queued',
    queued: 'Queued',
    hold: 'Hold',
    failed: 'Failed',
    posted: 'Posted',
    update: 'Update queued',
    updated: 'Updated',
    batchhold: 'Awaiting batch details',
    opencheck: 'Open check',
    openchecks: 'Open check',
    oob: 'Out of balance',
    updatehold: 'Update blocked',
    updatefailed: 'Update failed',
  }
  return labels[normalized] || canonicalStatus
}

function isSourceReady(status: string) {
  return ['ready', 'orders_only'].includes(status.toLowerCase())
}

function blockerActionLabel(blocker: PostingQueueBlocker) {
  const content = `${blocker.title} ${blocker.detail}`.toLowerCase()
  if (blocker.actionKind === 'mapping') return blocker.sourceKind === 'payment_exception'
    ? 'Map payment exceptions'
    : 'Map account'
  if (blocker.actionKind === 'checks') {
    if (blocker.affectedChecks.length) return 'View affected checks'
    return blocker.affectedCheckCount > 0
      ? `Review ${blocker.affectedCheckCount} ${blocker.affectedCheckCount === 1 ? 'check' : 'checks'}`
      : 'Review checks'
  }
  if (blocker.actionKind === 'configuration') return /connect|company/.test(content) ? 'Reconnect QuickBooks' : 'Fix configuration'
  if (blocker.actionKind === 'posting_review') return 'Open posting review'
  if (blocker.actionKind === 'reload') return /settlement/.test(content) ? 'Reload settlement' : 'Reload sales'
  if (/out of balance|unbalanced/.test(content)) return 'Review journal'
  if (/source reconciliation|source variance/.test(content)) return 'Reload sales'
  if (/batch|fee detail|payout/.test(content)) return 'Review batch details'
  if (/failed|error/.test(content)) return 'Review failure'
  return 'Reload and recheck'
}

function postingScopeKey(source: DataRecord) {
  const restaurantGuid = textValue(source, ['restaurantGuid', 'locationGuid']).toLowerCase()
  const businessDate = dateOnlyValue(firstValue(source, ['businessDate', 'date']))
  return restaurantGuid && businessDate ? `${restaurantGuid}:${businessDate}` : ''
}

function withReadinessBlockers(draft: DataRecord, additions: DataRecord[]) {
  if (!additions.length) return draft
  const sourceSummary = record(firstValue(draft, ['sourceSummary']))
  const canonical = record(firstValue(sourceSummary, ['canonical']))
  const readiness = record(firstValue(canonical, ['readiness']))
  return {
    ...draft,
    sourceSummary: {
      ...sourceSummary,
      canonical: {
        ...canonical,
        readiness: {
          ...readiness,
          hold: true,
          readyForReview: false,
          blockers: [...recordList(firstValue(readiness, ['blockers', 'issues'])), ...additions],
        },
      },
    },
  }
}

function postingQueueSources(
  drafts: DataRecord[],
  accountingIssues: DataRecord[],
  syncIssues: DataRecord[],
  locations: PosLocation[],
) {
  const locationNames = new Map(locations.map((entry) => [entry.id.toLowerCase(), entry.name]))
  const sources = new Map<string, DataRecord>()
  drafts.forEach((draft, index) => {
    const key = postingScopeKey(draft) || `draft:${textValue(draft, ['id'], String(index))}`
    sources.set(key, draft)
  })

  for (const issueState of accountingIssues) {
    const key = postingScopeKey(issueState)
    if (!key) continue
    const restaurantGuid = textValue(issueState, ['restaurantGuid', 'locationGuid']).toLowerCase()
    const businessDate = dateOnlyValue(firstValue(issueState, ['businessDate', 'date']))
    const current = sources.get(key) || {
      id: `accounting-issue:${key}`,
      restaurantGuid,
      restaurantName: textValue(issueState, ['locationName', 'restaurantName'], locationNames.get(restaurantGuid) || 'Toast location'),
      businessDate,
      status: 'hold',
      reconciliationStatus: 'pending',
      sourceSummary: {},
    }
    sources.set(key, withReadinessBlockers(current, recordList(issueState.issues)))
  }

  for (const syncIssue of syncIssues) {
    const syncStatus = textValue(syncIssue, ['status']).toLowerCase()
    if (!['failed', 'dead', 'missing', 'stale'].includes(syncStatus)) continue
    const key = postingScopeKey(syncIssue)
    if (!key) continue
    const restaurantGuid = textValue(syncIssue, ['restaurantGuid', 'locationGuid']).toLowerCase()
    const businessDate = dateOnlyValue(firstValue(syncIssue, ['businessDate', 'date']))
    const syncKind = displayStatus(textValue(syncIssue, ['syncKind'], 'Toast sales'))
    const lastError = textValue(syncIssue, ['lastError', 'error'], 'Toast sales could not be loaded for this business date.')
    const statusDescription = syncStatus === 'dead'
      ? 'stopped'
      : syncStatus === 'missing'
        ? 'missing'
        : syncStatus === 'stale'
          ? 'overdue'
          : 'failed'
    const current = sources.get(key) || {
      id: `sync-issue:${key}`,
      restaurantGuid,
      restaurantName: textValue(syncIssue, ['locationName', 'restaurantName'], locationNames.get(restaurantGuid) || 'Toast location'),
      businessDate,
      reconciliationStatus: 'failed',
      sourceSummary: {},
    }
    sources.set(key, {
      ...withReadinessBlockers(current, [{
        code: `sync_${syncStatus}:${textValue(syncIssue, ['syncKind'], 'sales')}`,
        title: `${syncKind} sync ${statusDescription}`,
        detail: lastError,
        action: 'Reload sales',
      }]),
      queueStatusOverride: 'failed',
      lastError,
    })
  }

  return [...sources.values()].sort((left, right) => (
    dateOnlyValue(firstValue(right, ['businessDate', 'date']))
      .localeCompare(dateOnlyValue(firstValue(left, ['businessDate', 'date'])))
  ))
}

function queueDraft(draft: DataRecord, index: number): PostingQueueDraft {
  const sourceSummary = record(firstValue(draft, ['sourceSummary']))
  const canonical = record(firstValue(sourceSummary, ['canonical']))
  const readinessCandidate = record(firstValue(canonical, ['readiness']))
  const readiness = Object.keys(readinessCandidate).length
    ? readinessCandidate
    : record(firstValue(sourceSummary, ['readiness']))
  const blockers: PostingQueueBlocker[] = []

  const addBlocker = (input: Omit<PostingQueueBlocker, 'key'> & { key?: string }) => {
    const title = input.title.trim()
    const detail = input.detail.trim()
    if (!title && !detail) return
    const key = input.key || `${input.actionKind}:${input.sourceKind}:${input.sourceId}:${title}:${detail}`
    const duplicateIndex = blockers.findIndex((entry) => entry.key === key || (
      entry.title.toLowerCase() === title.toLowerCase()
      && entry.detail.toLowerCase() === detail.toLowerCase()
    ) || (
      input.actionKind === 'mapping'
      && entry.actionKind === 'mapping'
      && Boolean(input.sourceKind && input.sourceId)
      && entry.sourceKind === input.sourceKind
      && entry.sourceId === input.sourceId
    ))
    if (duplicateIndex >= 0) {
      const existing = blockers[duplicateIndex]
      blockers[duplicateIndex] = {
        ...existing,
        ...input,
        key: existing.key,
        title: title || existing.title,
        detail: detail || existing.detail,
        affectedChecks: input.affectedChecks.length ? input.affectedChecks : existing.affectedChecks,
        affectedCheckCount: Math.max(existing.affectedCheckCount, input.affectedCheckCount),
      }
      return
    }
    blockers.push({ ...input, key, title: title || 'Review the posting hold', detail })
  }

  for (const missing of recordList(firstValue(readiness, ['missingMappings']))) {
    const sourceKind = textValue(missing, ['sourceKind'], 'source')
    const sourceId = textValue(missing, ['sourceId'])
    const sourceName = textValue(missing, ['sourceName', 'name'], displayStatus(sourceKind))
    const targetType = textValue(missing, ['targetType'], 'destination').replaceAll('_', ' ')
    addBlocker({
      key: `missing_mapping:${sourceKind}:${sourceId}:${targetType}`,
      title: `Map ${sourceName}`,
      detail: `${sourceKind.replaceAll('_', ' ')} needs a QuickBooks ${targetType} mapping.`,
      actionKind: 'mapping',
      sourceKind,
      sourceId,
      sourceName,
      affectedChecks: affectedChecks(firstValue(missing, ['affectedChecks', 'checks', 'orders'])),
      affectedCheckCount: affectedCheckCount(firstValue(missing, ['affectedChecks']), []),
    })
  }

  const structuredBlockers = recordList(firstValue(readiness, ['blockers', 'issues']))
  for (const issue of structuredBlockers) {
    const mapping = record(firstValue(issue, ['mapping', 'source']))
    const sourceKind = textValue(issue, ['sourceKind'], textValue(mapping, ['sourceKind', 'kind']))
    const sourceId = textValue(issue, ['sourceId'], textValue(mapping, ['sourceId', 'id']))
    const sourceName = textValue(issue, ['sourceName'], textValue(mapping, ['sourceName', 'name']))
    const title = textValue(issue, ['title', 'message', 'reason'], 'Review the posting hold')
    const detail = textValue(issue, ['detail', 'description'])
    const issueChecks = affectedChecks(firstValue(issue, ['affectedChecks', 'checks', 'orders', 'orderGuids', 'checkGuids']))
    addBlocker({
      key: textValue(issue, ['code', 'id']),
      title,
      detail,
      actionKind: blockerActionKind(issue, sourceKind, title, detail),
      sourceKind,
      sourceId,
      sourceName,
      affectedChecks: issueChecks,
      affectedCheckCount: affectedCheckCount(firstValue(issue, ['affectedChecks', 'checkCount']), issueChecks),
    })
  }

  const sharedAffectedChecks = affectedChecks(firstValue(readiness, [
    'affectedChecks',
    'paymentExceptionChecks',
    'openChecks',
  ]))
  const paymentExceptions = record(firstValue(readiness, ['paymentExceptions']))
  const sharedAffectedCheckCount = affectedCheckCount(
    firstValue(paymentExceptions, ['affectedChecks']),
    sharedAffectedChecks,
  )
  const holdReasons = Array.isArray(readiness.holdReasons) ? readiness.holdReasons : []
  for (const [reasonIndex, value] of holdReasons.entries()) {
    const reason = scalarText(value)
    if (!reason) continue
    const normalizedReason = reason.replace(/[.!]\s*$/, '').toLowerCase()
    if (blockers.some((entry) => (
      entry.title.replace(/[.!]\s*$/, '').toLowerCase() === normalizedReason
      || entry.detail.replace(/[.!]\s*$/, '').toLowerCase() === normalizedReason
    ))) continue
    const actionKind = blockerActionKind({}, '', reason, '')
    addBlocker({
      key: `hold_reason:${reasonIndex}:${reason}`,
      title: reason.replace(/[.!]\s*$/, ''),
      detail: '',
      actionKind,
      sourceKind: '',
      sourceId: '',
      sourceName: '',
      affectedChecks: actionKind === 'checks' ? sharedAffectedChecks : [],
      affectedCheckCount: actionKind === 'checks' ? sharedAffectedCheckCount : 0,
    })
  }

  const rawStatus = textValue(draft, ['queueStatusOverride', 'status']).toLowerCase()
  const reportedStatus = textValue(
    draft,
    ['queueStatusOverride', 'postingStatus', 'externalPostingStatus', 'shogoStatus', 'status'],
  ).toLowerCase()
  const compactReportedStatus = reportedStatus.replace(/[\s_-]+/g, '')
  const reconciliation = textValue(draft, ['reconciliationStatus', 'reconciliation']).toLowerCase()
  if (reconciliation && !isSourceReady(reconciliation) && !['posted', 'posting'].includes(rawStatus)) {
    addBlocker({
      key: `reconciliation:${reconciliation}`,
      title: `Resolve ${displayStatus(reconciliation)} source reconciliation`,
      detail: 'Reload Toast sales, then regenerate accounting after every required source finishes.',
      actionKind: 'preview',
      sourceKind: '',
      sourceId: '',
      sourceName: '',
      affectedChecks: [],
      affectedCheckCount: 0,
    })
  }
  if (rawStatus === 'needs_mapping' && !blockers.some((entry) => entry.actionKind === 'mapping')) {
    addBlocker({
      key: 'missing_mapping:unknown',
      title: 'Complete the required QuickBooks mappings',
      detail: 'Open catalog mappings to map every posting source.',
      actionKind: 'mapping',
      sourceKind: '',
      sourceId: '',
      sourceName: '',
      affectedChecks: [],
      affectedCheckCount: 0,
    })
  }
  if (rawStatus === 'failed' || ['failed', 'updatefailed'].includes(compactReportedStatus)) {
    addBlocker({
      key: 'posting_failed',
      title: compactReportedStatus === 'updatefailed' ? 'Review the failed posting update' : 'Review the failed posting',
      detail: textValue(draft, ['lastError', 'error'], 'Correct the blocker, regenerate accounting, and retry.'),
      actionKind: 'posting_review',
      sourceKind: '',
      sourceId: '',
      sourceName: '',
      affectedChecks: [],
      affectedCheckCount: 0,
    })
  }

  const blockerKeys = blockers.map((entry) => entry.key.toLowerCase())
  const inferredReportedStatus = blockerKeys.some((key) => key === 'update_hold' || key.startsWith('update_hold:'))
    ? 'updatehold'
    : blockerKeys.some((key) => key === 'open_check' || key.startsWith('open_check:'))
      ? 'opencheck'
      : blockerKeys.some((key) => key === 'out_of_balance' || key.startsWith('out_of_balance:'))
        ? 'oob'
        : blockerKeys.some((key) => key.startsWith('batch_hold'))
          ? 'batchhold'
          : blockers.length > 0 ? 'hold' : reportedStatus
  const effectiveReportedStatus = [
    'empty', 'none', 'post', 'queued', 'hold', 'failed', 'posted', 'update',
    'updated', 'batchhold', 'opencheck', 'openchecks', 'oob', 'updatehold', 'updatefailed',
  ].includes(compactReportedStatus)
    ? reportedStatus
    : inferredReportedStatus
  const compactEffectiveStatus = effectiveReportedStatus.replace(/[\s_-]+/g, '').toLowerCase()

  let status: PostingQueueStatus
  if (rawStatus === 'failed' || ['failed', 'updatefailed'].includes(compactEffectiveStatus)) status = 'Failed'
  else if (rawStatus === 'posted' || ['posted', 'updated'].includes(compactEffectiveStatus)) status = 'Posted'
  else if (rawStatus === 'posting' || ['post', 'queued', 'update'].includes(compactEffectiveStatus)) status = 'Posting'
  else if (['hold', 'batchhold', 'opencheck', 'openchecks', 'oob', 'updatehold'].includes(compactEffectiveStatus)) status = 'Hold'
  else if (blockers.length > 0 || readiness.hold === true || readiness.readyForReview === false) status = 'Hold'
  else status = 'Ready'

  return {
    draft,
    key: textValue(draft, ['id', 'guid'], String(index)),
    status,
    statusLabel: postingStatusLabel(effectiveReportedStatus, status),
    blockers,
  }
}

function Metric({ label, value, detail, color = '#F3F4F6' }: {
  label: string
  value: string
  detail: string
  color?: string
}) {
  return (
    <Box sx={{ ...panelSx, p: 1.5, minWidth: 0, minHeight: 88 }}>
      <Typography variant="caption" color="text.secondary" display="block" noWrap>{label}</Typography>
      <Typography fontSize="1.35rem" fontWeight={700} color={color} mt={0.35} noWrap>{value}</Typography>
      <Typography variant="caption" color="text.disabled" display="block" noWrap>{detail}</Typography>
    </Box>
  )
}

function ReadinessRow({ label, source, state, detail }: {
  label: string
  source: string
  state: ReturnType<typeof readinessEntry>
  detail?: string
}) {
  return (
    <Box sx={{ py: 1.25, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 1.5, alignItems: 'center' }}>
      <Box minWidth={0}>
        <Typography variant="body2" fontWeight={650}>{label}</Typography>
        <Typography variant="caption" color="text.secondary" display="block" noWrap>{detail || state.detail || source}</Typography>
      </Box>
      <Chip size="small" variant="outlined" color={state.tone} label={state.label} />
    </Box>
  )
}

function DailyTrend({ rows, money, dateLabel }: {
  rows: DataRecord[]
  money: (amount: number, compact?: boolean) => string
  dateLabel: (value: unknown, short?: boolean) => string
}) {
  const maximum = Math.max(1, ...rows.map((row) => numberValue(row, ['netSales', 'netSalesAmount'])))
  return (
    <Box sx={{ ...panelSx, p: { xs: 1.5, sm: 2 }, minHeight: 242, overflow: 'hidden' }}>
      <Box display="flex" justifyContent="space-between" alignItems="flex-start" gap={2} mb={1.5}>
        <Box minWidth={0}>
          <Typography fontWeight={700}>Daily sales</Typography>
          <Typography variant="caption" color="text.secondary">Net sales by business date</Typography>
        </Box>
        <Box display="flex" alignItems="center" gap={0.75} flexShrink={0}>
          <Box width={8} height={8} borderRadius="2px" bgcolor="#70D6A7" />
          <Typography variant="caption" color="text.secondary">Net sales</Typography>
        </Box>
      </Box>
      {rows.length ? (
        <Box sx={{ overflowX: 'auto', pb: 0.5, scrollbarWidth: 'thin' }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: `repeat(${rows.length}, minmax(38px, 1fr))`,
              gap: 0.75,
              height: 172,
              minWidth: Math.max(360, rows.length * 40),
            }}
          >
            {rows.map((row, index) => {
              const date = firstValue(row, ['businessDate', 'date', 'day'])
              const netSales = numberValue(row, ['netSales', 'netSalesAmount'])
              const orders = Math.round(numberValue(row, ['orders', 'ordersCount', 'orderCount']))
              return (
                <Tooltip key={`${String(date)}-${index}`} title={`${dateLabel(date)} · ${money(netSales)} · ${orders.toLocaleString()} orders`}>
                  <Box sx={{ display: 'grid', gridTemplateRows: '1fr auto auto', minWidth: 0 }}>
                    <Box display="flex" alignItems="flex-end" justifyContent="center" minHeight={0}>
                      <Box
                        aria-label={`${dateLabel(date)} net sales ${money(netSales)}`}
                        sx={{
                          width: '62%',
                          maxWidth: 25,
                          minHeight: 3,
                          height: `${Math.max(2, (netSales / maximum) * 100)}%`,
                          borderRadius: '3px 3px 0 0',
                          bgcolor: '#70D6A7',
                          opacity: netSales ? 1 : 0.32,
                        }}
                      />
                    </Box>
                    <Typography variant="caption" color="text.secondary" textAlign="center" mt={0.5} lineHeight={1.2} noWrap>
                      {dateLabel(date, true)}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" textAlign="center" fontSize="0.625rem" noWrap>
                      {orders.toLocaleString()} ord
                    </Typography>
                  </Box>
                </Tooltip>
              )
            })}
          </Box>
        </Box>
      ) : (
        <Box minHeight={170} display="grid" sx={{ placeItems: 'center' }}>
          <Typography variant="body2" color="text.secondary">No daily sales in this range</Typography>
        </Box>
      )}
    </Box>
  )
}

export default function PosSection() {
  const dateTimeSettings = useUserDateTime()
  const [view, setView] = useState<PosView>('overview')
  const [from, setFrom] = useState(() => localDate(-29))
  const [to, setTo] = useState(() => localDate(0))
  const [location, setLocation] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [revision, setRevision] = useState(0)
  const [capabilities, setCapabilities] = useState<PosCapabilities | null>(null)
  const [snapshot, setSnapshot] = useState<PosSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [selectedOrderSummary, setSelectedOrderSummary] = useState<DataRecord | null>(null)
  const [orderDetail, setOrderDetail] = useState<DataRecord | null>(null)
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderError, setOrderError] = useState<string | null>(null)
  const [queryReady, setQueryReady] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [guideHandledOrganization, setGuideHandledOrganization] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [selectedDraftKey, setSelectedDraftKey] = useState('')
  const [accountingFocusAction, setAccountingFocusAction] = useState<PosAccountingFocusAction | null>(null)

  const invalidRange = Boolean(from && to && from > to)

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search)
    const targetView = parameters.get('posView')
    const targetDate = parameters.get('date')
    const targetLocation = parameters.get('location')
    if (targetView && ['overview', 'orders', 'reports', 'accounting'].includes(targetView)) {
      setView(targetView as PosView)
    }
    if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      setFrom(targetDate)
      setTo(targetDate)
    }
    if (targetLocation && /^[0-9a-f-]{36}$/i.test(targetLocation)) {
      setLocation(targetLocation.toLowerCase())
    }
    setQueryReady(true)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    const organizationId = snapshot?.organizationId || ''
    if (!organizationId || guideHandledOrganization === organizationId) return
    setGuideHandledOrganization(organizationId)
    try {
      if (window.localStorage.getItem(`clawpilot.pos.guide.seen:${organizationId}`) !== '1') {
        setGuideOpen(true)
      }
    } catch {
      setGuideOpen(true)
    }
  }, [guideHandledOrganization, snapshot?.organizationId])

  useEffect(() => {
    if (!queryReady || !from || !to || invalidRange) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ from, to, page: String(page), pageSize: String(pageSize) })
    if (location) params.set('location', location)
    if (search) params.set('search', search)

    async function load() {
      try {
        const response = await fetch(`/api/pos?${params}`, { cache: 'no-store', signal: controller.signal })
        const payload = await response.json().catch(() => ({})) as PosPayload
        const nextCapabilities: PosCapabilities = {
          canView: response.status === 403 ? false : payload.capabilities?.canView !== false,
          canManage: payload.capabilities?.canManage === true,
        }
        setCapabilities(nextCapabilities)
        if (!response.ok || payload.ok !== true || !payload.pos) {
          throw new Error(payload.error || 'POS data is unavailable')
        }
        setSnapshot(normalizeSnapshot(payload.pos))
      } catch (loadError) {
        if ((loadError as Error).name !== 'AbortError') setError((loadError as Error).message)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    void load()
    return () => controller.abort()
  }, [from, invalidRange, location, page, pageSize, queryReady, revision, search, to])

  useEffect(() => {
    if (!queryReady || !selectedOrderId || !from || !to || invalidRange) return
    const controller = new AbortController()
    setOrderLoading(true)
    setOrderError(null)
    const params = new URLSearchParams({
      from,
      to,
      page: String(page),
      pageSize: String(pageSize),
      order: selectedOrderId,
    })
    if (location) params.set('location', location)

    async function loadOrder() {
      try {
        const response = await fetch(`/api/pos?${params}`, { cache: 'no-store', signal: controller.signal })
        const payload = await response.json().catch(() => ({})) as PosPayload
        if (!response.ok || payload.ok !== true || !payload.pos) {
          throw new Error(payload.error || 'Order detail is unavailable')
        }
        const selectedOrder = normalizeSnapshot(payload.pos).selectedOrder
        if (!selectedOrder) throw new Error('Order detail is unavailable')
        setOrderDetail(selectedOrder)
      } catch (loadError) {
        if ((loadError as Error).name !== 'AbortError') setOrderError((loadError as Error).message)
      } finally {
        if (!controller.signal.aborted) setOrderLoading(false)
      }
    }

    void loadOrder()
    return () => controller.abort()
  }, [from, invalidRange, location, page, pageSize, queryReady, selectedOrderId, to])

  const currencyCode = textValue(snapshot?.summary || {}, ['currencyCode', 'currency'], 'USD')
  const money = useMemo(() => (amount: number, compact = false) => {
    try {
      return new Intl.NumberFormat(dateTimeSettings.locale, {
        style: 'currency',
        currency: currencyCode,
        notation: compact ? 'compact' : 'standard',
        maximumFractionDigits: compact ? 1 : 2,
      }).format(Number(amount || 0))
    } catch {
      return new Intl.NumberFormat(dateTimeSettings.locale, { maximumFractionDigits: 2 }).format(Number(amount || 0))
    }
  }, [currencyCode, dateTimeSettings.locale])

  const number = useMemo(() => (value: number, maximumFractionDigits = 0) => (
    new Intl.NumberFormat(dateTimeSettings.locale, { maximumFractionDigits }).format(value)
  ), [dateTimeSettings.locale])

  const dateLabel = useMemo(() => (value: unknown, short = false) => {
    const date = scalarText(value)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date || '—'
    return new Intl.DateTimeFormat(dateTimeSettings.locale, short
      ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
      : { dateStyle: 'medium', timeZone: 'UTC' })
      .format(new Date(`${date}T12:00:00Z`))
  }, [dateTimeSettings.locale])

  const dateTimeLabel = useMemo(() => (value: unknown) => {
    const candidate = scalarText(value)
    if (!candidate) return '—'
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return dateLabel(candidate)
    try {
      return formatUserDateTime(candidate, dateTimeSettings, { dateStyle: 'medium', timeStyle: 'short' })
    } catch {
      return candidate
    }
  }, [dateLabel, dateTimeSettings])

  const summary = snapshot?.summary || {}
  const netSales = numberValue(summary, ['netSales', 'netSalesAmount'])
  const grossSales = numberValue(summary, ['grossSales', 'grossSalesAmount'])
  const ordersCount = numberValue(summary, ['orders', 'ordersCount', 'orderCount'])
  const guestCount = numberValue(summary, ['guests', 'guestCount'])
  const averageCheck = numberValue(summary, ['averageCheck', 'averageOrder', 'averageTicket'], ordersCount ? netSales / ordersCount : 0)
  const discounts = numberValue(summary, ['discounts', 'discountAmount'])
  const refunds = numberValue(summary, ['refunds', 'refundAmount'])
  const preorderCount = numberValue(summary, ['preorderCount'])

  const daily = useMemo(() => {
    const grouped = new Map<string, DataRecord>()
    for (const row of snapshot?.daily || []) {
      const businessDate = textValue(row, ['businessDate', 'date', 'day'])
      if (!businessDate) continue
      const aggregate = grouped.get(businessDate) || { businessDate }
      for (const key of ['orderCount', 'grossSales', 'netSales', 'tax', 'tips', 'discounts', 'serviceCharges', 'tendered', 'total']) {
        aggregate[key] = numberValue(aggregate, [key]) + numberValue(row, [key])
      }
      grouped.set(businessDate, aggregate)
    }
    return [...grouped.values()].sort((left, right) => (
      textValue(left, ['businessDate']).localeCompare(textValue(right, ['businessDate']))
    ))
  }, [snapshot?.daily])

  const filteredOrders = snapshot?.orders.items || []

  const currentPage = snapshot?.orders.page || page
  const currentPageSize = snapshot?.orders.pageSize || pageSize
  const totalOrders = snapshot?.orders.total || 0
  const totalPages = Math.max(1, Math.ceil(totalOrders / currentPageSize))
  const firstOrder = totalOrders ? (currentPage - 1) * currentPageSize + 1 : 0
  const lastOrder = totalOrders ? Math.min(totalOrders, firstOrder + (snapshot?.orders.items.length || 0) - 1) : 0

  const readiness = snapshot?.readiness || {}
  const datasets = record(firstValue(readiness, ['datasets']))
  const analyticsDataset = record(firstValue(datasets, ['analyticsSales']))
  const standardDataset = record(firstValue(datasets, ['standardOrders']))
  const analyticsConfigured = booleanValue(readiness, ['analyticsConfigured']) === true
  const standardConfigured = booleanValue(readiness, ['standardConfigured']) === true
  const standardDataReady = ordersCount > 0
    || numberValue(standardDataset, ['records']) > 0
    || numberValue(standardDataset, ['successfulJobs']) > 0
  const analyticsReadiness = readinessEntry({
    source: !analyticsConfigured
      ? 'needs_setup'
      : numberValue(analyticsDataset, ['failedJobs']) > 0 && numberValue(analyticsDataset, ['successfulJobs']) === 0
        ? 'failed'
        : numberValue(analyticsDataset, ['successfulJobs']) > 0 ? 'ready' : 'waiting',
  }, ['source'])
  const standardReadiness = readinessEntry({
    source: standardDataReady
      ? 'ready'
      : !standardConfigured
      ? 'needs_setup'
      : numberValue(standardDataset, ['failedJobs']) > 0 && numberValue(standardDataset, ['successfulJobs']) === 0
        ? 'failed'
        : numberValue(standardDataset, ['successfulJobs']) > 0 ? 'ready' : 'waiting',
  }, ['source'])
  const latestSync = textValue(readiness, ['latestSyncAt', 'lastSyncedAt', 'updatedAt'])

  const drafts = snapshot?.drafts
  const accountingDrafts = draftItems(drafts)
  const postingSources = postingQueueSources(
    accountingDrafts,
    snapshot?.accountingIssues || [],
    snapshot?.syncIssues || [],
    snapshot?.locations || [],
  )
  const postingQueue = postingSources.map(queueDraft)
  const visiblePostingQueue = issuesOnly
    ? postingQueue.filter((entry) => ['Hold', 'Failed'].includes(entry.status))
    : postingQueue
  const draftMetrics = [
    { label: 'Hold', value: postingQueue.filter((entry) => entry.status === 'Hold').length, color: '#F2B76D' },
    { label: 'Ready', value: postingQueue.filter((entry) => entry.status === 'Ready').length, color: '#A8C7FA' },
    { label: 'Posting', value: postingQueue.filter((entry) => entry.status === 'Posting').length, color: '#CFC6EA' },
    { label: 'Posted', value: postingQueue.filter((entry) => entry.status === 'Posted').length, color: '#70D6A7' },
    { label: 'Failed', value: postingQueue.filter((entry) => entry.status === 'Failed').length, color: '#FF8A80' },
  ]
  const reconciledDrafts = accountingDrafts.filter((draft) => (
    isSourceReady(textValue(draft, ['reconciliationStatus']))
  )).length
  const accountingReadiness = readinessEntry({
    source: accountingDrafts.length
      ? reconciledDrafts === accountingDrafts.length ? 'ready' : reconciledDrafts ? 'partial' : 'waiting'
      : standardConfigured && analyticsConfigured ? 'waiting' : 'needs_setup',
  }, ['source'])

  const detailSource = orderDetail || selectedOrderSummary || {}
  const nestedOrder = record(firstValue(detailSource, ['order']))
  const detail = Object.keys(nestedOrder).length ? { ...detailSource, ...nestedOrder } : detailSource
  const checks = orderChecks(detail)
  const detailPreorder = isPreorder(detail)
  const detailFulfillmentDate = orderFulfillmentDate(detail)
  const detailPaymentDates = orderPaymentDates(detail)

  function closeOrder() {
    setSelectedOrderId(null)
    setSelectedOrderSummary(null)
    setOrderDetail(null)
    setOrderError(null)
    setOrderLoading(false)
  }

  function openOrder(order: DataRecord) {
    const id = orderId(order)
    if (!id) return
    setSelectedOrderId(id)
    setSelectedOrderSummary(order)
    setOrderDetail(null)
    setOrderError(null)
  }

  function resetQueryState() {
    setPage(1)
    closeOrder()
  }

  function selectAccountingDraft(entry: PostingQueueDraft) {
    const draftDate = textValue(entry.draft, ['businessDate', 'date'])
    const draftLocation = textValue(entry.draft, ['restaurantGuid', 'locationGuid'])
    if (draftDate) {
      setFrom(draftDate)
      setTo(draftDate)
    }
    if (draftLocation) setLocation(draftLocation)
    setPage(1)
    closeOrder()
    setSelectedDraftKey(entry.key)
    setAccountingFocusAction(null)
  }

  function openPostingReview(entry: PostingQueueDraft) {
    const draftId = textValue(entry.draft, ['id', 'guid'])
    const businessDate = textValue(entry.draft, ['businessDate', 'date'])
    try {
      const oldURL = window.location.href
      const nextURL = buildPosPostingReviewUrl(oldURL, { draftId, businessDate })
      window.history.pushState({}, '', `${nextURL.pathname}${nextURL.search}${nextURL.hash}`)
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: nextURL.toString() }))
    } catch (navigationError) {
      setError((navigationError as Error).message)
    }
  }

  function takeAccountingAction(entry: PostingQueueDraft, blocker: PostingQueueBlocker) {
    selectAccountingDraft(entry)
    if (blocker.actionKind === 'posting_review') {
      openPostingReview(entry)
      return
    }
    const firstCheck = blocker.affectedChecks[0]
    if (blocker.actionKind === 'checks') {
      const checkSearch = firstCheck?.displayNumber || firstCheck?.checkGuid || firstCheck?.orderGuid || ''
      setSearchInput(checkSearch)
      setSearch(checkSearch)
      setView('orders')
      if (firstCheck?.orderGuid) {
        setSelectedOrderId(firstCheck.orderGuid)
        setSelectedOrderSummary(null)
      }
      return
    }
    setView('accounting')
    setAccountingFocusAction({
      key: `${entry.key}:${blocker.key}:${Date.now()}`,
      kind: blocker.actionKind,
      sourceKind: blocker.sourceKind,
      sourceId: blocker.sourceId,
      sourceName: blocker.sourceName,
    })
  }

  function closeGuide() {
    const organizationId = snapshot?.organizationId || ''
    if (organizationId) {
      try {
        window.localStorage.setItem(`clawpilot.pos.guide.seen:${organizationId}`, '1')
      } catch {
        // The guide remains available from the toolbar when storage is restricted.
      }
    }
    setGuideOpen(false)
  }

  return (
    <Box height="100%" display="flex" flexDirection="column" minWidth={0} bgcolor="#0F0F13">
      <Box
        sx={{
          px: { xs: 1.5, sm: 2, md: 3 },
          pt: { xs: 1.25, md: 2 },
          pb: 1.25,
          flexShrink: 0,
          '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
            pt: 0.75,
            pb: 0.75,
          },
        }}
      >
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={1.25}>
          <Box minWidth={0}>
            <Box display="flex" alignItems="center" gap={1} minWidth={0}>
              <PointOfSaleRounded sx={{ color: '#A8C7FA', fontSize: 23, flexShrink: 0 }} />
              <Typography variant="h5" fontWeight={700} noWrap>POS</Typography>
              <Chip size="small" variant="outlined" label="Toast" sx={{ display: { xs: 'none', sm: 'inline-flex' } }} />
              {capabilities && !capabilities.canManage ? <Chip size="small" variant="outlined" label="Read only" /> : null}
            </Box>
            <Typography variant="caption" color="text.secondary" display="block" mt={0.15} noWrap>
              {latestSync ? `Updated ${dateTimeLabel(latestSync)}` : 'Sales, orders, and accounting drafts'}
            </Typography>
          </Box>
          <Box display="flex" alignItems="center" gap={0.75}>
            <Tooltip title="How POS works">
              <IconButton
                aria-label="Open POS guide"
                onClick={() => setGuideOpen(true)}
                sx={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', width: 40, height: 40 }}
              >
                <HelpOutlineRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh POS data">
              <span>
                <IconButton
                  aria-label="Refresh POS data"
                  onClick={() => setRevision((value) => value + 1)}
                  disabled={loading}
                  sx={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', width: 40, height: 40 }}
                >
                  {loading ? <CircularProgress size={18} /> : <RefreshRounded fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: '144px 144px minmax(210px, 300px)' },
            gap: 1,
            maxWidth: { sm: 620 },
          }}
        >
          <TextField
            label="From"
            type="date"
            value={from}
            onChange={(event) => { setFrom(event.target.value); resetQueryState() }}
            size="small"
            InputLabelProps={{ shrink: true }}
            inputProps={{ max: to || localDate(0) }}
            error={invalidRange}
            sx={controlSx}
          />
          <TextField
            label="To"
            type="date"
            value={to}
            onChange={(event) => { setTo(event.target.value); resetQueryState() }}
            size="small"
            InputLabelProps={{ shrink: true }}
            inputProps={{ min: from, max: localDate(0) }}
            error={invalidRange}
            sx={controlSx}
          />
          <TextField
            select
            label="Location"
            value={location}
            onChange={(event) => { setLocation(event.target.value); resetQueryState() }}
            size="small"
            sx={{ ...controlSx, gridColumn: { xs: '1 / -1', sm: 'auto' } }}
          >
            <MenuItem value="">All locations</MenuItem>
            {(snapshot?.locations || []).map((candidate, index) => (
              <MenuItem key={candidate.id || `${candidate.name}-${index}`} value={candidate.id} disabled={!candidate.id}>
                {candidate.name}{candidate.code ? ` · ${candidate.code}` : ''}{candidate.testMode ? ' · Test' : ''}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        {invalidRange ? <Typography variant="caption" color="error" display="block" mt={0.75}>The start date must be on or before the end date.</Typography> : null}
      </Box>

      <Tabs
        value={view}
        onChange={(_, next: PosView) => setView(next)}
        aria-label="POS views"
        sx={{
          px: { xs: 1, md: 2 },
          minHeight: 44,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
          '& .MuiTab-root': { minHeight: 44, textTransform: 'none', letterSpacing: 0, minWidth: 92 },
        }}
      >
        <Tab value="overview" label="Overview" />
        <Tab value="orders" label="Orders" />
        <Tab value="reports" label="Reports" />
        <Tab value="accounting" label="Accounting" />
      </Tabs>

      {loading && snapshot ? <LinearProgress sx={{ flexShrink: 0, height: 2 }} /> : null}

      <Box flex={1} minHeight={0} overflow="auto" sx={{ WebkitOverflowScrolling: 'touch' }}>
        <Box sx={{ px: { xs: 1.5, sm: 2, md: 3 }, py: { xs: 1.5, md: 2.5 }, maxWidth: 1500, mx: 'auto' }}>
          {error ? <Alert severity="error" sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
          {capabilities?.canView === false ? (
            <Alert severity="warning" sx={{ borderRadius: '8px' }}>You do not have access to POS data for this organization.</Alert>
          ) : loading && !snapshot ? (
            <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(6, minmax(0, 1fr))' }} gap={1.25}>
              {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} variant="rounded" height={88} sx={{ borderRadius: '8px' }} />)}
            </Box>
          ) : snapshot && view === 'overview' ? (
            <Stack spacing={2}>
              <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', xl: 'repeat(6, minmax(0, 1fr))' }} gap={1.25}>
                <Metric label="Net sales" value={money(netSales, true)} detail={`Gross ${money(grossSales, true)}`} color="#70D6A7" />
                <Metric label="Orders" value={number(ordersCount)} detail={`${number(guestCount)} guests`} color="#A8C7FA" />
                <Metric label="Average check" value={money(averageCheck)} detail="Per order" />
                <Metric label="Guests" value={number(guestCount)} detail={ordersCount ? `${number(guestCount / ordersCount, 1)} per order` : 'No orders'} />
                <Metric label="Discounts" value={money(discounts, true)} detail="Applied discounts" color="#F2B76D" />
                <Metric label="Refunds" value={money(refunds, true)} detail="Returned sales" color={refunds ? '#FF8A80' : '#70D6A7'} />
              </Box>

              <Box display="grid" gridTemplateColumns={{ xs: '1fr', lg: 'minmax(0, 1.55fr) minmax(280px, 0.45fr)' }} gap={2}>
                <DailyTrend rows={daily} money={money} dateLabel={dateLabel} />
                <Box sx={{ ...panelSx, p: { xs: 1.5, sm: 2 } }}>
                  <Typography fontWeight={700}>Data readiness</Typography>
                  <Typography variant="caption" color="text.secondary">Current range and selected locations</Typography>
                  <Divider sx={{ mt: 1.25 }} />
                  <ReadinessRow label="POS orders" source="Toast Standard API" state={standardReadiness} detail="Toast Standard API" />
                  <Divider />
                  <ReadinessRow label="Sales reconciliation" source="Toast Analytics" state={analyticsReadiness} detail="Toast Analytics" />
                  <Divider />
                  <ReadinessRow label="Accounting drafts" source="ClawPilot durable store" state={accountingReadiness} detail="ClawPilot durable store" />
                </Box>
              </Box>
            </Stack>
          ) : snapshot && view === 'orders' ? (
            <Stack spacing={1.5}>
              <Box display="flex" alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" gap={1.5} flexDirection={{ xs: 'column', sm: 'row' }}>
                <TextField
                  value={searchInput}
                  onChange={(event) => { setSearchInput(event.target.value); setPage(1); closeOrder() }}
                  placeholder="Search orders"
                  aria-label="Search orders"
                  size="small"
                  sx={{ ...controlSx, width: { xs: '100%', sm: 360 } }}
                  InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
                />
                <Box display="flex" alignItems="center" gap={0.75} flexWrap="wrap" justifyContent="flex-end">
                  {preorderCount > 0 ? <Chip size="small" color="info" label={`${number(preorderCount)} ${preorderCount === 1 ? 'preorder' : 'preorders'}`} /> : null}
                  <Typography variant="caption" color="text.secondary" whiteSpace="nowrap">
                    {number(totalOrders)} orders
                  </Typography>
                </Box>
              </Box>

              {preorderCount > 0 ? (
                <Alert severity="info" variant="outlined" sx={{ borderRadius: '8px' }}>
                  {number(preorderCount)} paid {preorderCount === 1 ? 'order has' : 'orders have'} a future fulfillment date. The orders appear here now; sales totals remain on their fulfillment business dates.
                </Alert>
              ) : null}

              <Box sx={{ ...panelSx, overflow: 'hidden' }}>
                <TableContainer sx={{ display: { xs: 'none', md: 'block' } }}>
                  <Table size="small" aria-label="POS orders">
                    <TableHead>
                      <TableRow>
                        {['Order', 'Business date', 'Location', 'Status', 'Checks', 'Total'].map((label, index) => (
                          <TableCell key={label} align={index >= 4 ? 'right' : 'left'} sx={{ bgcolor: '#171821', color: 'text.secondary', fontWeight: 700, whiteSpace: 'nowrap' }}>{label}</TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {filteredOrders.map((order, index) => {
                        const id = orderId(order)
                        const status = orderStatus(order)
                        const checkCount = recordList(firstValue(order, ['checks'])).length || numberValue(order, ['checkCount', 'checksCount'])
                        const preorder = isPreorder(order)
                        const fulfillmentDate = orderFulfillmentDate(order)
                        return (
                          <TableRow
                            key={id || index}
                            hover={Boolean(id)}
                            tabIndex={id ? 0 : -1}
                            role={id ? 'button' : undefined}
                            onClick={() => openOrder(order)}
                            onKeyDown={(event) => { if (id && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openOrder(order) } }}
                            sx={{ cursor: id ? 'pointer' : 'default', '& td': { borderColor: 'rgba(255,255,255,0.065)' } }}
                          >
                            <TableCell>
                              <Box display="flex" alignItems="center" gap={0.65} flexWrap="wrap">
                                <Typography variant="body2" fontWeight={650}>{orderLabel(order)}</Typography>
                                {preorder ? <Chip size="small" color="info" variant="outlined" label="Preorder" sx={{ height: 22 }} /> : null}
                              </Box>
                              <Typography variant="caption" color="text.disabled">Toast order</Typography>
                            </TableCell>
                            <TableCell>
                              <Typography variant="body2">{dateLabel(firstValue(order, ['businessDate', 'date']))}</Typography>
                              {preorder ? <Typography variant="caption" color="info.light" display="block">Fulfills {dateLabel(fulfillmentDate)}</Typography> : null}
                            </TableCell>
                            <TableCell>{textValue(order, ['locationName', 'restaurantName'], '—')}</TableCell>
                            <TableCell><Chip size="small" variant="outlined" color={statusTone(status)} label={status} /></TableCell>
                            <TableCell align="right">{number(checkCount)}</TableCell>
                            <TableCell align="right"><Typography variant="body2" fontWeight={700}>{money(numberValue(order, ['totalAmount', 'total', 'amount']))}</Typography></TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>

                <Box sx={{ display: { xs: 'block', md: 'none' } }}>
                  {filteredOrders.map((order, index) => {
                    const id = orderId(order)
                    const status = orderStatus(order)
                    const preorder = isPreorder(order)
                    const fulfillmentDate = orderFulfillmentDate(order)
                    return (
                      <Box
                        key={id || index}
                        component="button"
                        type="button"
                        disabled={!id}
                        onClick={() => openOrder(order)}
                        sx={{
                          width: '100%', minHeight: 78, px: 1.5, py: 1.25, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto',
                          gap: 1.25, textAlign: 'left', color: 'inherit', font: 'inherit', border: 0,
                          borderBottom: '1px solid rgba(255,255,255,0.065)', bgcolor: 'transparent', cursor: id ? 'pointer' : 'default',
                          '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' }, '&:disabled': { color: 'inherit' },
                        }}
                      >
                        <Box minWidth={0}>
                          <Box display="flex" alignItems="center" gap={0.75} mb={0.35} minWidth={0}>
                            <Typography variant="body2" fontWeight={700} noWrap>{orderLabel(order)}</Typography>
                            {preorder ? <Chip size="small" color="info" variant="outlined" label="Preorder" sx={{ height: 22, flexShrink: 0 }} /> : null}
                            <Chip size="small" variant="outlined" color={statusTone(status)} label={status} sx={{ height: 22, flexShrink: 0 }} />
                          </Box>
                          <Typography variant="caption" color="text.secondary" display="block" noWrap>
                            {dateLabel(firstValue(order, ['businessDate', 'date']))} · {textValue(order, ['locationName', 'restaurantName'], 'All locations')}
                          </Typography>
                          <Typography variant="caption" color={preorder ? 'info.light' : 'text.disabled'} display="block" noWrap>
                            {preorder ? `Future fulfillment ${dateLabel(fulfillmentDate)}` : 'Toast order detail'}
                          </Typography>
                        </Box>
                        <Typography variant="body2" fontWeight={700} whiteSpace="nowrap" alignSelf="center">
                          {money(numberValue(order, ['totalAmount', 'total', 'amount']))}
                        </Typography>
                      </Box>
                    )
                  })}
                </Box>

                {!filteredOrders.length ? (
                  <Box minHeight={160} display="grid" sx={{ placeItems: 'center' }} px={2}>
                    <Typography variant="body2" color="text.secondary">{search ? 'No orders match this search' : 'No orders in this range'}</Typography>
                  </Box>
                ) : null}

                <Box sx={{ minHeight: 52, px: 1, py: 0.75, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: { xs: 0.5, sm: 1.25 }, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <TextField
                    select
                    label="Rows"
                    size="small"
                    value={pageSize}
                    onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); closeOrder() }}
                    sx={{ ...controlSx, width: 82 }}
                  >
                    {[10, 25, 50].map((value) => <MenuItem key={value} value={value}>{value}</MenuItem>)}
                  </TextField>
                  <Typography variant="caption" color="text.secondary" minWidth={{ xs: 72, sm: 96 }} textAlign="center" whiteSpace="nowrap">
                    {firstOrder}–{lastOrder} of {number(totalOrders)}
                  </Typography>
                  <Tooltip title="Previous page">
                    <span><IconButton aria-label="Previous orders page" disabled={currentPage <= 1 || loading} onClick={() => { setPage(Math.max(1, currentPage - 1)); closeOrder() }}><ChevronLeftRounded /></IconButton></span>
                  </Tooltip>
                  <Tooltip title="Next page">
                    <span><IconButton aria-label="Next orders page" disabled={currentPage >= totalPages || loading} onClick={() => { setPage(Math.min(totalPages, currentPage + 1)); closeOrder() }}><ChevronRightRounded /></IconButton></span>
                  </Tooltip>
                </Box>
              </Box>
            </Stack>
          ) : snapshot && view === 'reports' ? (
            <PosReportsPanel
              from={from}
              to={to}
              location={location}
              revision={revision}
              money={money}
              number={number}
              dateLabel={dateLabel}
            />
          ) : snapshot && view === 'accounting' ? (
            <Stack spacing={2}>
              <Box display="flex" justifyContent="space-between" alignItems="flex-start" gap={2}>
                <Box>
                  <Typography fontWeight={700}>Accounting posting queue</Typography>
                  <Typography variant="caption" color="text.secondary">Resolve holds before anything posts to QuickBooks</Typography>
                </Box>
                <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" justifyContent="flex-end">
                  <FormControlLabel
                    control={<Switch size="small" checked={issuesOnly} onChange={(event) => setIssuesOnly(event.target.checked)} />}
                    label="Issues only"
                    sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: '0.8rem' } }}
                  />
                  <Chip size="small" variant="outlined" color={capabilities?.canManage ? 'info' : 'default'} label={capabilities?.canManage ? 'Manage access' : 'Read only'} />
                </Box>
              </Box>

              <Box display="grid" gridTemplateColumns={{ xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(5, minmax(0, 1fr))' }} gap={1.25}>
                {draftMetrics.map((metric) => <Metric key={metric.label} label={metric.label} value={number(metric.value)} detail="Drafts" color={metric.color} />)}
              </Box>

              <Box display="grid" gridTemplateColumns={{ xs: '1fr', lg: 'minmax(0, 1fr) minmax(280px, 0.42fr)' }} gap={2}>
                <Box sx={{ ...panelSx, overflow: 'hidden' }}>
                  <Box px={{ xs: 1.5, sm: 2 }} py={1.5} borderBottom="1px solid rgba(255,255,255,0.08)" display="flex" alignItems="center" justifyContent="space-between" gap={1}>
                    <Box>
                      <Typography fontWeight={700}>Posting dates in range</Typography>
                      <Typography variant="caption" color="text.secondary">Select a row to load its exact location and business date</Typography>
                    </Box>
                    {issuesOnly ? <Chip size="small" color="warning" variant="outlined" label={`${visiblePostingQueue.length} issues`} /> : null}
                  </Box>
                  {visiblePostingQueue.length ? visiblePostingQueue.map((entry) => {
                    const { draft } = entry
                    const sourceSummary = record(firstValue(draft, ['sourceSummary']))
                    const standardSummary = record(firstValue(sourceSummary, ['standard']))
                    const draftAmount = numberValue(
                      standardSummary,
                      ['total', 'netSales'],
                      numberValue(sourceSummary, ['grossSales', 'netSales']),
                    )
                    const topBlocker = entry.blockers[0]
                    const selected = selectedDraftKey === entry.key
                    const canOpenPostingReview = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                      .test(textValue(draft, ['id', 'guid']))
                    return (
                      <Box
                        key={entry.key}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open ${dateLabel(firstValue(draft, ['businessDate', 'date']))} accounting posting`}
                        onClick={() => selectAccountingDraft(entry)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            selectAccountingDraft(entry)
                          }
                        }}
                        sx={{
                          px: { xs: 1.5, sm: 2 },
                          py: 1.5,
                          borderBottom: '1px solid rgba(255,255,255,0.065)',
                          bgcolor: selected ? 'rgba(168,199,250,0.08)' : 'transparent',
                          boxShadow: selected ? 'inset 3px 0 #A8C7FA' : 'none',
                          cursor: 'pointer',
                          outline: 'none',
                          transition: 'background-color 120ms ease',
                          '&:hover, &:focus-visible': { bgcolor: 'rgba(255,255,255,0.045)' },
                        }}
                      >
                        <Box
                          display="grid"
                          gridTemplateColumns={{ xs: 'minmax(0, 1fr) auto', sm: 'minmax(120px, 0.55fr) minmax(0, 1fr) auto auto' }}
                          alignItems="center"
                          gap={1.25}
                        >
                          <Box minWidth={0}>
                            <Typography variant="body2" fontWeight={650}>{dateLabel(firstValue(draft, ['businessDate', 'date']))}</Typography>
                            <Typography variant="caption" color="text.disabled" sx={{ display: { sm: 'none' } }}>{textValue(draft, ['locationName', 'restaurantName'], 'All locations')}</Typography>
                          </Box>
                          <Typography variant="body2" color="text.secondary" noWrap sx={{ display: { xs: 'none', sm: 'block' } }}>{textValue(draft, ['locationName', 'restaurantName'], 'All locations')}</Typography>
                          <Typography variant="body2" fontWeight={650} textAlign="right" whiteSpace="nowrap">{money(draftAmount)}</Typography>
                          <Box display="flex" gap={0.65} justifyContent="flex-end" flexWrap="wrap" sx={{ gridColumn: { xs: '1 / -1', sm: 'auto' } }}>
                            <Chip size="small" variant="outlined" color={statusTone(entry.status)} label={entry.statusLabel} />
                            {entry.blockers.length ? <Chip size="small" color="warning" label={`${entry.blockers.length} ${entry.blockers.length === 1 ? 'blocker' : 'blockers'}`} /> : null}
                          </Box>
                        </Box>
                        {topBlocker ? (
                          <Box
                            mt={1.15}
                            pt={1.15}
                            borderTop="1px solid rgba(255,255,255,0.055)"
                            display="flex"
                            flexDirection={{ xs: 'column', sm: 'row' }}
                            alignItems={{ xs: 'stretch', sm: 'center' }}
                            justifyContent="space-between"
                            gap={1}
                          >
                            <Box minWidth={0}>
                              <Typography variant="body2" color={entry.status === 'Failed' ? 'error.light' : 'warning.light'} fontWeight={650}>
                                Can&apos;t post: {topBlocker.title}
                              </Typography>
                              {topBlocker.detail ? <Typography variant="caption" color="text.secondary" display="block">{topBlocker.detail}</Typography> : null}
                              {entry.blockers.length > 1 ? <Typography variant="caption" color="text.disabled" display="block">+{entry.blockers.length - 1} more {entry.blockers.length === 2 ? 'blocker' : 'blockers'}</Typography> : null}
                            </Box>
                            <Button
                              variant="outlined"
                              color={entry.status === 'Failed' ? 'error' : 'warning'}
                              size="small"
                              endIcon={<ArrowForwardRounded />}
                              onClick={(event) => {
                                event.stopPropagation()
                                takeAccountingAction(entry, topBlocker)
                              }}
                              sx={{ whiteSpace: 'nowrap', alignSelf: { xs: 'flex-start', sm: 'center' } }}
                            >
                              {blockerActionLabel(topBlocker)}
                            </Button>
                          </Box>
                        ) : (
                          <Box display="flex" flexDirection={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between" gap={1} mt={0.75}>
                            <Typography variant="caption" color="text.secondary" display="block">
                              {entry.status === 'Ready'
                                ? 'Ready for accounting review and approval.'
                                : displayStatus(textValue(draft, ['reconciliationStatus', 'reconciliation'], 'Pending reconciliation'))}
                            </Typography>
                            {canOpenPostingReview ? (
                              <Button
                                variant="outlined"
                                size="small"
                                endIcon={<ArrowForwardRounded />}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  openPostingReview(entry)
                                }}
                                sx={{ whiteSpace: 'nowrap' }}
                              >
                                {entry.status === 'Ready' ? 'Open posting review' : 'View posting'}
                              </Button>
                            ) : null}
                          </Box>
                        )}
                      </Box>
                    )
                  }) : (
                    <Box minHeight={150} display="grid" sx={{ placeItems: 'center' }} px={2}>
                      <Typography variant="body2" color="text.secondary">
                        {issuesOnly && postingQueue.length ? 'No posting issues in this range' : 'No accounting drafts in this range'}
                      </Typography>
                    </Box>
                  )}
                </Box>

                <Box sx={{ ...panelSx, p: 2, alignSelf: 'start' }}>
                  <Typography fontWeight={700}>Reconciliation readiness</Typography>
                  <Divider sx={{ mt: 1.25 }} />
                  <ReadinessRow label="Sales source" source="Toast Analytics" state={analyticsReadiness} />
                  <Divider />
                  <ReadinessRow label="Order source" source="Toast Standard API" state={standardReadiness} />
                  <Divider />
                  <ReadinessRow label="Draft output" source="ClawPilot durable store" state={accountingReadiness} />
                </Box>
              </Box>

              <PosAccountingPanel
                location={location}
                businessDate={to}
                revision={revision}
                money={money}
                number={number}
                focusAction={accountingFocusAction}
              />
            </Stack>
          ) : null}
        </Box>
      </Box>

      <PosGuideDialog
        open={guideOpen}
        onClose={closeGuide}
        onOpenView={(nextView) => setView(nextView)}
        isDemo={snapshot ? isDemoWorkspaceId(snapshot.organizationId) : null}
        canManage={capabilities?.canManage === true}
        standardStatus={standardReadiness.label}
        analyticsStatus={analyticsReadiness.label}
        accountingStatus={accountingReadiness.label}
        hasAccountingDraft={accountingDrafts.length > 0}
      />

      <Drawer
        anchor="right"
        open={Boolean(selectedOrderId)}
        onClose={closeOrder}
        PaperProps={{
          sx: {
            width: { xs: '100vw', sm: 560 },
            maxWidth: '100vw',
            height: '100dvh',
            bgcolor: '#0F0F13',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            flexDirection: 'column',
          },
        }}
      >
        <Box sx={{ minHeight: { xs: 'calc(env(safe-area-inset-top) + 62px)', sm: 62 }, pt: { xs: 'env(safe-area-inset-top)', sm: 0 }, px: 2, display: 'flex', alignItems: 'center', gap: 1.25, borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          <PointOfSaleRounded sx={{ color: '#A8C7FA', flexShrink: 0 }} />
          <Box minWidth={0} flex={1}>
            <Box display="flex" alignItems="center" gap={0.65} minWidth={0}>
              <Typography fontWeight={700} noWrap>{orderLabel(detail)}</Typography>
              {detailPreorder ? <Chip size="small" color="info" variant="outlined" label="Preorder" sx={{ height: 22, flexShrink: 0 }} /> : null}
            </Box>
            <Typography variant="caption" color="text.secondary" display="block" noWrap>
              {dateLabel(firstValue(detail, ['businessDate', 'date']))} · {textValue(detail, ['locationName', 'restaurantName'], 'POS order')}
            </Typography>
          </Box>
          {orderLoading ? <CircularProgress size={19} /> : null}
          <Tooltip title="Close order detail">
            <IconButton aria-label="Close order detail" onClick={closeOrder} sx={{ width: 44, height: 44 }}><CloseRounded /></IconButton>
          </Tooltip>
        </Box>

        <Box flex={1} minHeight={0} overflow="auto" sx={{ WebkitOverflowScrolling: 'touch' }}>
          <Box sx={{ p: { xs: 1.5, sm: 2 } }}>
            {orderError ? <Alert severity="warning" sx={{ mb: 2, borderRadius: '8px' }}>{orderError}</Alert> : null}

            <Box display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={1.5}>
              <Box>
                <Typography variant="caption" color="text.secondary">Order total</Typography>
                <Typography variant="h6" fontWeight={700}>{money(numberValue(detail, ['totalAmount', 'total', 'amount']))}</Typography>
              </Box>
              <Box display="flex" alignItems="center" gap={0.65} flexWrap="wrap" justifyContent="flex-end">
                {detailPreorder ? <Chip size="small" color="info" label="Future fulfillment" /> : null}
                <Chip size="small" variant="outlined" color={statusTone(orderStatus(detail))} label={orderStatus(detail)} />
              </Box>
            </Box>

            <Box display="grid" gridTemplateColumns="repeat(2, minmax(0, 1fr))" columnGap={2} rowGap={1.25} mb={2}>
              {[
                ['Opened', dateTimeLabel(firstValue(detail, ['openedAt', 'openedDate', 'createdAt']))],
                ['Closed', dateTimeLabel(firstValue(detail, ['closedAt', 'closedDate', 'paidDate']))],
                ...(detailFulfillmentDate ? [['Fulfillment', dateLabel(detailFulfillmentDate)]] : []),
                ...(detailPaymentDates.length ? [['Payment date', detailPaymentDates.map((date) => dateLabel(date, true)).join(', ')]] : []),
                ['Checks', number(checks.length)],
                ['Items', number(checks.reduce((total, check) => total + recordList(firstValue(check, ['items', 'selections'])).length, 0))],
                ['Dining option', textValue(detail, ['diningOptionName', 'diningOption', 'serviceType'], '—')],
                ['Source', textValue(detail, ['source', 'sourceName', 'channel'], 'Toast')],
              ].map(([label, value]) => (
                <Box key={label} minWidth={0}>
                  <Typography variant="caption" color="text.disabled" display="block">{label}</Typography>
                  <Typography variant="body2" noWrap>{value}</Typography>
                </Box>
              ))}
            </Box>

            <Divider />
            <Box display="flex" alignItems="center" justifyContent="space-between" py={1.5}>
              <Typography fontWeight={700}>Checks</Typography>
              <Typography variant="caption" color="text.secondary">{number(checks.length)}</Typography>
            </Box>

            {checks.length ? checks.map((check, checkIndex) => {
              const items = recordList(firstValue(check, ['items', 'selections']))
              const payments = recordList(firstValue(check, ['payments']))
              const checkStatus = displayStatus(textValue(check, ['status', 'paymentStatus'], booleanValue(check, ['voided']) ? 'Voided' : 'Open'))
              return (
                <Box key={textValue(check, ['guid', 'id'], String(checkIndex))} sx={{ borderTop: checkIndex ? '1px solid rgba(255,255,255,0.08)' : 0, pt: checkIndex ? 2 : 0, pb: 2 }}>
                  <Box display="flex" justifyContent="space-between" alignItems="center" gap={1.5} mb={1.25}>
                    <Box minWidth={0}>
                      <Typography variant="body2" fontWeight={700} noWrap>{textValue(check, ['displayNumber', 'checkNumber', 'name'], `Check ${checkIndex + 1}`)}</Typography>
                      <Typography variant="caption" color="text.secondary">{items.length} items · {payments.length} payments</Typography>
                    </Box>
                    <Box display="flex" alignItems="center" gap={0.75}>
                      <Chip size="small" variant="outlined" color={statusTone(checkStatus)} label={checkStatus} />
                      <Typography variant="body2" fontWeight={700} whiteSpace="nowrap">{money(numberValue(check, ['totalAmount', 'total', 'amount']))}</Typography>
                    </Box>
                  </Box>

                  <Typography variant="caption" color="text.disabled" fontWeight={700}>ITEMS</Typography>
                  <Box mt={0.5}>
                    {items.length ? items.map((item, itemIndex) => {
                      const quantity = numberValue(item, ['quantity', 'qty'], 1)
                      const modifiers = recordList(firstValue(item, ['modifiers']))
                      return (
                        <Box key={textValue(item, ['guid', 'id'], String(itemIndex))} sx={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: 1, py: 0.75, alignItems: 'start' }}>
                          <Typography variant="body2" color="text.secondary">{number(quantity, 2)}×</Typography>
                          <Box minWidth={0}>
                            <Typography variant="body2" fontWeight={550}>{itemName(item)}</Typography>
                            {modifiers.map((modifier, modifierIndex) => (
                              <Box key={textValue(modifier, ['guid', 'id'], String(modifierIndex))} display="flex" justifyContent="space-between" gap={1}>
                                <Typography variant="caption" color="text.disabled">{itemName(modifier)}</Typography>
                                <Typography variant="caption" color="text.disabled">{money(numberValue(modifier, ['amount']))}</Typography>
                              </Box>
                            ))}
                            {booleanValue(item, ['voided', 'isVoided']) ? <Typography variant="caption" color="error">Voided</Typography> : null}
                          </Box>
                          <Typography variant="body2" fontWeight={650} whiteSpace="nowrap">{money(numberValue(item, ['totalAmount', 'net', 'gross', 'price', 'amount']))}</Typography>
                        </Box>
                      )
                    }) : <Typography variant="body2" color="text.secondary" py={1}>No item detail</Typography>}
                  </Box>

                  <Divider sx={{ my: 1 }} />
                  <Typography variant="caption" color="text.disabled" fontWeight={700}>PAYMENTS</Typography>
                  <Box mt={0.5}>
                    {payments.length ? payments.map((payment, paymentIndex) => {
                      const paymentStatus = booleanValue(payment, ['refunded'])
                        ? 'Refunded'
                        : displayStatus(textValue(payment, ['status', 'paymentStatus'], 'Recorded'))
                      const paymentType = textValue(payment, ['paymentMethod', 'type', 'cardType', 'tenderType'], 'Payment')
                      return (
                        <Box key={textValue(payment, ['guid', 'id'], String(paymentIndex))} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 1, py: 0.75, alignItems: 'center' }}>
                          <Box minWidth={0}>
                            <Typography variant="body2" fontWeight={550} noWrap>{paymentType}</Typography>
                            <Typography variant="caption" color={statusTone(paymentStatus) === 'error' ? 'error' : 'text.secondary'}>{paymentStatus}</Typography>
                          </Box>
                          <Box textAlign="right">
                            <Typography variant="body2" fontWeight={650}>{money(numberValue(payment, ['amount', 'totalAmount']))}</Typography>
                            {numberValue(payment, ['tipAmount', 'tip']) ? <Typography variant="caption" color="text.secondary">Tip {money(numberValue(payment, ['tipAmount', 'tip']))}</Typography> : null}
                          </Box>
                        </Box>
                      )
                    }) : <Typography variant="body2" color="text.secondary" py={1}>No payment detail</Typography>}
                  </Box>
                </Box>
              )
            }) : (
              <Alert severity={orderLoading ? 'info' : 'warning'} sx={{ borderRadius: '8px' }}>
                {orderLoading ? 'Loading checks, items, and payments.' : 'No check detail is available for this order.'}
              </Alert>
            )}
          </Box>
        </Box>
      </Drawer>
    </Box>
  )
}
