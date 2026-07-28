'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  IconButton,
  InputAdornment,
  FormControlLabel,
  Link,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import AccountTreeRounded from '@mui/icons-material/AccountTreeRounded'
import ArchiveRounded from '@mui/icons-material/ArchiveRounded'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import BusinessRounded from '@mui/icons-material/BusinessRounded'
import CampaignRounded from '@mui/icons-material/CampaignRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import EmailRounded from '@mui/icons-material/EmailRounded'
import EventRounded from '@mui/icons-material/EventRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import PhoneRounded from '@mui/icons-material/PhoneRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import SyncAltRounded from '@mui/icons-material/SyncAltRounded'
import UploadFileRounded from '@mui/icons-material/UploadFileRounded'
import DownloadRounded from '@mui/icons-material/DownloadRounded'
import CallMergeRounded from '@mui/icons-material/CallMergeRounded'
import CrmDataTransferDialog from '@/components/crm/CrmDataTransferDialog'
import ProductIdentityDialog from '@/components/crm/ProductIdentityDialog'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { annotateInteractionEventHistory } from '@/lib/crm/interactionHistory.mjs'
import WorkspaceSelector from '@/components/workspaces/WorkspaceSelector'
import type {
  CrmEntity,
  CrmSummary,
  ProductSalesChannelState,
} from '@/lib/crm/types'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'
import { dateTimeLocalValue, zonedDateTimeToIso } from '@/lib/zonedDateTime'

type RecordValue = Record<string, unknown>
type CrmActionType = 'send_email' | 'create_calendar_event' | 'log_call' | 'send_campaign'
type CrmActionPayload = {
  ok?: boolean
  error?: string
  action?: {
    status?: string
    lastError?: string | null
    responseSummary?: Record<string, unknown>
  }
}
type CampaignRecipient = {
  id: string
  contactId?: string | null
  leadId?: string | null
  referenceCode: string
  name: string
  email: string
  status: string
  sentAt?: string | null
  lastError?: string | null
}
type PipelineInfo = {
  id: string
  name: string
  ownerEmail: string
  workspaceOrganizationId: string | null
  accessRole: 'owner' | 'editor' | 'viewer'
  shortLinkUrl: string | null
}
type CrmPipelineUser = {
  referenceCode: string
  email: string
  displayName: string
  suiteCrmMapped: boolean
}
type WorkspaceOrganization = {
  id: string
  parentId: string | null
  parentName: string | null
  name: string
  organizationType: 'root' | 'member'
  depth: number
  members: Array<{
    email: string
    displayName: string | null
    role: 'owner' | 'admin' | 'member'
    status: 'invited' | 'active' | 'disabled'
  }>
}
type CrmPayload = {
  ok?: boolean
  error?: string
  entity?: CrmEntity
  records?: RecordValue[]
  summary?: CrmSummary
  pipeline?: PipelineInfo
  workspaceHierarchy?: WorkspaceOrganization[]
  hierarchy?: WorkspaceOrganization[]
  pipelineUsers?: CrmPipelineUser[]
  campaignRecipients?: CampaignRecipient[]
  canManageHierarchy?: boolean
  canManageProductIdentities?: boolean
  suiteCrmPunchoutUrl?: string | null
  suiteCrmUsername?: string | null
  suiteCrmAdminPortalUrl?: string | null
  providerIdentities?: {
    googleMail?: string | null
    googleCalendar?: string | null
  }
}
type CrmLifecyclePayload = {
  ok?: boolean
  error?: string
  result?: {
    archived?: boolean
    created?: boolean
    accountReferenceCode?: string
    contactReferenceCode?: string
    opportunityReferenceCode?: string
  }
}
type LifecycleDialog = {
  type: 'archive' | 'convert-lead'
  record: RecordValue
}
type EditorHistoryItem = {
  entity: CrmEntity
  record: RecordValue
  fields: Record<string, string>
}
type DropdownOption = { active?: boolean; sort_order?: number; label?: string; value?: string }

const DEFAULT_PRIORITIES = ['A+', 'A', 'B', 'C', 'D']
const LEGACY_CONTACT_OWNER = '__legacy_contact_owner__'
const LEGACY_ORGANIZATION_OWNER = '__legacy_organization_owner__'
const DEFAULT_ORGANIZATION_TYPES = [
  'Prospect',
  'Customer',
  'Partner',
  'Reseller',
  'Supplier',
  'Competitor',
  'Other',
]
const INTERACTION_TYPES = [
  { value: 'email', label: 'Email' },
  { value: 'call', label: 'Call' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'note', label: 'Note' },
  { value: 'campaign', label: 'Campaign' },
] as const

const ACTIVITY_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'held', label: 'Held' },
  { value: 'not_held', label: 'Not held' },
] as const

function interactionTypeValue(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (normalized === 'in person') return 'meeting'
  return INTERACTION_TYPES.some((option) => option.value === normalized) ? normalized : String(value || '').trim()
}

const ENTITY_LABELS: Record<CrmEntity, string> = {
  organizations: 'Organizations',
  contacts: 'Contacts',
  leads: 'Leads',
  opportunities: 'Opportunities',
  products: 'Products',
  meetings: 'Meetings',
  interactions: 'Interactions',
  campaigns: 'Campaigns',
}

const EMPTY_SUMMARY: CrmSummary = {
  organizations: 0,
  contacts: 0,
  leads: 0,
  opportunities: 0,
  products: 0,
  meetings: 0,
  interactions: 0,
  campaigns: 0,
  openPipelineValue: 0,
  weightedPipelineValue: 0,
  pendingSync: 0,
  failedSync: 0,
  needsReviewInteractions: 0,
}

function textValue(record: RecordValue, key: string) {
  return String(record[key] ?? '')
}

function idList(value: unknown) {
  const values = Array.isArray(value) ? value : String(value || '').split(',')
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)))
}

function recordIdList(record: RecordValue, key: string) {
  return idList(record[key])
}

function recordsForOrganization(records: RecordValue[], organizationId: string) {
  if (!organizationId) return records
  return records.filter((record) => textValue(record, 'organizationId') === organizationId)
}

function opportunityOptionLabel(record: RecordValue) {
  const products = Array.isArray(record.products)
    ? record.products
      .map((product) => product && typeof product === 'object' ? textValue(product as RecordValue, 'name') : '')
      .filter(Boolean)
    : []
  const productLabel = products.join(', ') || textValue(record, 'name') || 'Untitled opportunity'
  const context = [
    textValue(record, 'organization') || textValue(record, 'organizationName'),
    textValue(record, 'stage'),
    textValue(record, 'referenceCode'),
  ].filter(Boolean)
  return context.length > 0 ? `${productLabel} - ${context.join(' · ')}` : productLabel
}

function displayValue(record: RecordValue, key: string, settings: UserDateTimeSettings) {
  if (key === 'startsAt' || key === 'occurredAt') {
    return formatUserDateTime(textValue(record, key), settings, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: '—',
    })
  }
  return textValue(record, key) || '—'
}

function emailOptedOut(record: RecordValue) {
  return record.emailOptOut === true || textValue(record, 'emailOptOut').toLowerCase() === 'true'
}

function money(value: unknown, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 })
      .format(Number(value) || 0)
  } catch {
    return `${currency} ${(Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  }
}

function productMoney(value: unknown, currency: string) {
  if (currency) return money(value, currency)
  return `Currency required · ${(Number(value) || 0).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })}`
}

function productSalesChannels(record: RecordValue) {
  if (!Array.isArray(record.salesChannels)) return []
  return record.salesChannels.filter((value): value is ProductSalesChannelState => (
    Boolean(value)
    && typeof value === 'object'
    && ['shopify', 'faire'].includes(
      String((value as Record<string, unknown>).provider || ''),
    )
  ))
}

function salesChannelStatusLabel(
  status: ProductSalesChannelState['normalizedStatus'],
) {
  if (status === 'active') return 'Source active'
  return status.slice(0, 1).toUpperCase() + status.slice(1)
}

function salesChannelStatusColor(
  status: ProductSalesChannelState['normalizedStatus'],
) {
  if (status === 'active') return 'success' as const
  if (status === 'draft') return 'warning' as const
  if (status === 'unlisted') return 'info' as const
  if (status === 'unavailable') return 'error' as const
  return 'default' as const
}

function providerLabel(provider: ProductSalesChannelState['provider']) {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function hierarchyDescendants(hierarchy: WorkspaceOrganization[], organizationId: string) {
  const descendants = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const organization of hierarchy) {
      if (organization.parentId === organizationId || (organization.parentId && descendants.has(organization.parentId))) {
        if (!descendants.has(organization.id)) {
          descendants.add(organization.id)
          changed = true
        }
      }
    }
  }
  return descendants
}

function columns(entity: CrmEntity) {
  if (entity === 'organizations') return [
    ['referenceCode', 'ID'], ['name', 'Organization'], ['parentOrganizationName', 'Parent'], ['relationshipType', 'Relationship'],
    ['accountManager', 'Owner'], ['phone', 'Phone'],
  ] as const
  if (entity === 'contacts') return [
    ['referenceCode', 'ID'], ['fullName', 'Contact'], ['organizationName', 'Organization'], ['jobTitle', 'Title'], ['email', 'Email'],
  ] as const
  if (entity === 'leads') return [
    ['referenceCode', 'ID'], ['fullName', 'Lead'], ['companyName', 'Company'], ['status', 'Status'], ['email', 'Email'],
  ] as const
  if (entity === 'opportunities') return [
    ['referenceCode', 'ID'], ['name', 'Opportunity'], ['organization', 'Organization'], ['stage', 'Stage'], ['value', 'Value'],
  ] as const
  if (entity === 'products') return [
    ['referenceCode', 'ID'], ['name', 'Product'], ['sku', 'SKU'],
    ['salesChannels', 'Sales channels'], ['status', 'Status'],
    ['price', 'Price'],
  ] as const
  if (entity === 'meetings') return [
    ['referenceCode', 'ID'], ['subject', 'Meeting'], ['startsAt', 'Starts'], ['status', 'Status'], ['contactName', 'Contact'],
  ] as const
  if (entity === 'campaigns') return [
    ['referenceCode', 'ID'], ['name', 'Campaign'], ['status', 'Status'], ['recipientCount', 'Recipients'], ['sentCount', 'Sent'],
  ] as const
  return [
    ['referenceCode', 'ID'], ['subject', 'Interaction'], ['organizationName', 'Organization'], ['interactionType', 'Type'],
    ['eventAction', 'Event action'], ['occurredAt', 'Date'], ['agentName', 'Agent'],
  ] as const
}

function entityForReference(reference: string): CrmEntity | null {
  const prefix = reference.slice(0, 2).toLowerCase()
  return ({
    ga: 'organizations', gc: 'contacts', gl: 'leads', go: 'opportunities', gp: 'products',
    gm: 'meetings', gi: 'interactions', gk: 'campaigns',
  } as Record<string, CrmEntity>)[prefix] || null
}

function initialFields(
  entity: CrmEntity,
  record: RecordValue | null,
  userTimeZone: string,
  defaultCurrencyCode: string,
): Record<string, string> {
  const source = record || {}
  if (entity === 'organizations') return {
    name: textValue(source, 'name'), priority: textValue(source, 'priority'), accountType: textValue(source, 'accountType'),
    accountManager: textValue(source, 'accountManager'), website: textValue(source, 'website'),
    linkedinUrl: textValue(source, 'linkedinUrl'), phone: textValue(source, 'phone'), email: textValue(source, 'email'),
    address: textValue(source, 'address'), city: textValue(source, 'city'), state: textValue(source, 'state'),
    postalCode: textValue(source, 'postalCode'), country: textValue(source, 'country'),
    emailOptOut: textValue(source, 'emailOptOut') || 'false', description: textValue(source, 'description'),
  }
  if (entity === 'contacts') return {
    fullName: textValue(source, 'fullName'), organizationId: textValue(source, 'organizationId'),
    firstName: textValue(source, 'firstName'), lastName: textValue(source, 'lastName'), priority: textValue(source, 'priority'),
    contactType: textValue(source, 'contactType'), accountManager: textValue(source, 'accountManager'),
    ownerUserReferenceCode: textValue(source, 'ownerUserReferenceCode'), ownerEmail: textValue(source, 'ownerEmail'),
    ownerDisplayName: textValue(source, 'ownerDisplayName'),
    jobTitle: textValue(source, 'jobTitle'), email: textValue(source, 'email'), linkedinUrl: textValue(source, 'linkedinUrl'),
    phoneWork: textValue(source, 'phoneWork'), phoneMobile: textValue(source, 'phoneMobile'),
    address: textValue(source, 'address'), city: textValue(source, 'city'), state: textValue(source, 'state'),
    postalCode: textValue(source, 'postalCode'), country: textValue(source, 'country'),
    emailOptOut: textValue(source, 'emailOptOut') || 'false', description: textValue(source, 'description'),
  }
  if (entity === 'leads') return {
    fullName: textValue(source, 'fullName'), organizationId: textValue(source, 'organizationId'),
    firstName: textValue(source, 'firstName'), lastName: textValue(source, 'lastName'),
    companyName: textValue(source, 'companyName'), jobTitle: textValue(source, 'jobTitle'),
    email: textValue(source, 'email'), phoneWork: textValue(source, 'phoneWork'),
    phoneMobile: textValue(source, 'phoneMobile'), status: textValue(source, 'status'),
    source: textValue(source, 'source'), assignedTo: textValue(source, 'assignedTo'),
    emailOptOut: textValue(source, 'emailOptOut') || 'false', description: textValue(source, 'description'),
  }
  if (entity === 'opportunities') return {
    name: textValue(source, 'name'), organizationId: textValue(source, 'organizationId'),
    stage: textValue(source, 'stage'), status: textValue(source, 'status'), value: textValue(source, 'value'),
    probability: textValue(source, 'probability'), expectedClose: textValue(source, 'expectedClose'),
    notes: textValue(source, 'notes'),
  }
  if (entity === 'products') return {
    name: textValue(source, 'name'), sku: textValue(source, 'sku'), productType: textValue(source, 'productType') || 'Good',
    category: textValue(source, 'category'), status: textValue(source, 'status') || 'Active',
    price: textValue(source, 'price'), cost: textValue(source, 'cost'),
    currency: textValue(source, 'currency') || (record ? '' : defaultCurrencyCode),
    url: textValue(source, 'url'), active: textValue(source, 'active') || 'true', description: textValue(source, 'description'),
  }
  if (entity === 'meetings') {
    const timezone = textValue(source, 'timezone') || 'America/New_York'
    return {
      subject: textValue(source, 'subject'), organizationId: textValue(source, 'organizationId'),
      contactId: textValue(source, 'contactId'), leadId: textValue(source, 'leadId'),
      opportunityId: textValue(source, 'opportunityId'), startsAt: dateTimeLocalValue(source.startsAt, timezone),
      endsAt: dateTimeLocalValue(source.endsAt, timezone), timezone,
      location: textValue(source, 'location'), attendeeEmails: Array.isArray(source.attendeeEmails)
        ? source.attendeeEmails.map(String).join(', ') : '', status: textValue(source, 'status') || 'planned',
      description: textValue(source, 'description'),
    }
  }
  if (entity === 'campaigns') return {
    name: textValue(source, 'name'), status: textValue(source, 'status') || 'draft',
    startDate: textValue(source, 'startDate'), endDate: textValue(source, 'endDate'),
    subjectTemplate: textValue(source, 'subjectTemplate'), bodyTemplate: textValue(source, 'bodyTemplate'),
    senderEmail: textValue(source, 'senderEmail'), description: textValue(source, 'description'),
  }
  const interactionContactIds = recordIdList(source, 'contactIds')
  const selectedInteractionContactIds = interactionContactIds.length > 0
    ? interactionContactIds
    : idList(source.contactId)
  const interactionType = interactionTypeValue(source.interactionType)
  const nativeActivity = (interactionType === 'call' || interactionType === 'meeting') && !source.meetingId
  return {
    subject: textValue(source, 'subject'), organizationId: textValue(source, 'organizationId'),
    contactId: selectedInteractionContactIds[0] || '', contactIds: selectedInteractionContactIds.join(','),
    leadId: textValue(source, 'leadId'),
    opportunityId: textValue(source, 'opportunityId'), meetingId: textValue(source, 'meetingId'),
    campaignId: textValue(source, 'campaignId'),
    interactionType, occurredAt: dateTimeLocalValue(source.occurredAt, userTimeZone),
    activityStatus: textValue(source, 'activityStatus') || (nativeActivity ? 'held' : ''),
    durationMinutes: textValue(source, 'durationMinutes')
      || (nativeActivity ? interactionType === 'call' ? '15' : '30' : ''),
    direction: interactionType === 'call'
      ? (textValue(source, 'direction') === 'inbound' ? 'inbound' : 'outbound')
      : textValue(source, 'direction'),
    agentEmail: textValue(source, 'agentEmail'), agentName: textValue(source, 'agentName'), description: textValue(source, 'description'),
  }
}

function contactFieldsForSave(fields: Record<string, string>) {
  const saved: Record<string, string | boolean> = {
    ...fields,
    emailOptOut: fields.emailOptOut === 'true',
  }
  if (!fields.ownerUserReferenceCode && fields.accountManager) {
    delete saved.ownerUserReferenceCode
    delete saved.ownerEmail
    delete saved.ownerDisplayName
  }
  return saved
}

function addressFields(record: RecordValue): Record<string, string> {
  return {
    address: textValue(record, 'address'),
    city: textValue(record, 'city'),
    state: textValue(record, 'state'),
    postalCode: textValue(record, 'postalCode'),
    country: textValue(record, 'country'),
  }
}

async function loadCrmOptions(entity: CrmEntity): Promise<RecordValue[]> {
  const response = await fetch(`/api/crm?entity=${entity}&limit=1000`)
  const payload = await response.json().catch(() => ({})) as CrmPayload
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Unable to load ${entity}`)
  return payload.records || []
}

function downloadResponseFile(response: Response, blob: Blob, fallbackName: string) {
  const disposition = response.headers.get('Content-Disposition') || ''
  const fileName = disposition.match(/filename="([^"]+)"/i)?.[1] || fallbackName
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000)
}

export default function CrmSection() {
  const dateTimeSettings = useUserDateTime()
  const {
    organizationCurrencyCode,
    loading: measurementPreferencesLoading,
    error: measurementPreferencesError,
    preferencesWritable,
    refresh: refreshMeasurementPreferences,
  } = useMeasurementSystem()
  const currencyPreferenceReady = !measurementPreferencesLoading
    && !measurementPreferencesError
    && preferencesWritable
  const narrowMobile = useMediaQuery('(max-width:599.95px)')
  const shortLandscape = useMediaQuery('(orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)')
  const [entity, setEntity] = useState<CrmEntity>('organizations')
  const [records, setRecords] = useState<RecordValue[]>([])
  const [summary, setSummary] = useState<CrmSummary>(EMPTY_SUMMARY)
  const [pipeline, setPipeline] = useState<PipelineInfo | null>(null)
  const [query, setQuery] = useState('')
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editorRecord, setEditorRecord] = useState<RecordValue | null | undefined>(undefined)
  const [editorEntity, setEditorEntity] = useState<CrmEntity>('organizations')
  const [editorHistory, setEditorHistory] = useState<EditorHistoryItem[]>([])
  const [fields, setFields] = useState<Record<string, string>>({})
  const [useOrganizationAddress, setUseOrganizationAddress] = useState(false)
  const [organizations, setOrganizations] = useState<RecordValue[]>([])
  const [contacts, setContacts] = useState<RecordValue[]>([])
  const [leads, setLeads] = useState<RecordValue[]>([])
  const [opportunities, setOpportunities] = useState<RecordValue[]>([])
  const [campaigns, setCampaigns] = useState<RecordValue[]>([])
  const [relatedActivity, setRelatedActivity] = useState<RecordValue[]>([])
  const [campaignRecipients, setCampaignRecipients] = useState<CampaignRecipient[]>([])
  const [relatedActivityLoading, setRelatedActivityLoading] = useState(false)
  const [priorityOptions, setPriorityOptions] = useState<string[]>(DEFAULT_PRIORITIES)
  const [organizationTypeOptions, setOrganizationTypeOptions] = useState<string[]>(DEFAULT_ORGANIZATION_TYPES)
  const [pipelineUsers, setPipelineUsers] = useState<CrmPipelineUser[]>([])
  const [workspaceHierarchy, setWorkspaceHierarchy] = useState<WorkspaceOrganization[]>([])
  const [canManageHierarchy, setCanManageHierarchy] = useState(false)
  const [
    canManageProductIdentities,
    setCanManageProductIdentities,
  ] = useState(false)
  const [suiteCrmPunchoutUrl, setSuiteCrmPunchoutUrl] = useState<string | null>(null)
  const [suiteCrmUsername, setSuiteCrmUsername] = useState<string | null>(null)
  const [suiteCrmAdminPortalUrl, setSuiteCrmAdminPortalUrl] = useState<string | null>(null)
  const [providerIdentities, setProviderIdentities] = useState({
    googleMail: null as string | null,
    googleCalendar: null as string | null,
  })
  const [suiteCrmAccessOpen, setSuiteCrmAccessOpen] = useState(false)
  const [hierarchyOpen, setHierarchyOpen] = useState(false)
  const [relatedContactsLoading, setRelatedContactsLoading] = useState(false)
  const [actionComposer, setActionComposer] = useState<{ type: CrmActionType; record: RecordValue } | null>(null)
  const [actionFields, setActionFields] = useState<Record<string, string>>({})
  const [lifecycleDialog, setLifecycleDialog] = useState<LifecycleDialog | null>(null)
  const [lifecycleFields, setLifecycleFields] = useState<Record<string, string>>({})
  const [dataTransferOpen, setDataTransferOpen] = useState(false)
  const [dataTransferExporting, setDataTransferExporting] = useState(false)
  const [productIdentityOpen, setProductIdentityOpen] = useState(false)
  const [routeQuery, setRouteQuery] = useState('')
  const [routeReady, setRouteReady] = useState(false)
  const deepLinkOpened = useRef(false)

  const load = useCallback(async (nextEntity: CrmEntity, nextQuery: string, nextNeedsReview = false) => {
    setLoading(true)
    setError('')
    try {
      const parameters = new URLSearchParams({ entity: nextEntity, query: nextQuery, limit: '1000' })
      if (nextEntity === 'interactions' && nextNeedsReview) parameters.set('needsReview', 'true')
      const response = await fetch(`/api/crm?${parameters}`)
      const payload = await response.json().catch(() => ({})) as CrmPayload
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to load CRM records')
      const nextRecords = payload.records || []
      setRecords(nextEntity === 'interactions' ? annotateInteractionEventHistory(nextRecords) : nextRecords)
      setSummary(payload.summary || EMPTY_SUMMARY)
      setPipeline(payload.pipeline || null)
      setWorkspaceHierarchy(payload.workspaceHierarchy || [])
      setPipelineUsers(payload.pipelineUsers || [])
      setCanManageHierarchy(payload.canManageHierarchy === true)
      setCanManageProductIdentities(
        payload.canManageProductIdentities === true,
      )
      setSuiteCrmPunchoutUrl(payload.suiteCrmPunchoutUrl || null)
      setSuiteCrmUsername(payload.suiteCrmUsername || null)
      setSuiteCrmAdminPortalUrl(payload.suiteCrmAdminPortalUrl || null)
      setProviderIdentities({
        googleMail: payload.providerIdentities?.googleMail || null,
        googleCalendar: payload.providerIdentities?.googleCalendar || null,
      })
      const reference = new URLSearchParams(window.location.search).get('crm')?.trim().toLowerCase() || ''
      const matched = reference && entityForReference(reference) === nextEntity
        ? (payload.records || []).find((record) => textValue(record, 'referenceCode') === reference)
        : null
      if (matched && !deepLinkOpened.current) {
        deepLinkOpened.current = true
        setEditorEntity(nextEntity)
        setEditorHistory([])
        setEditorRecord(matched)
        setFields(initialFields(
          nextEntity,
          matched,
          dateTimeSettings.timeZone,
          organizationCurrencyCode,
        ))
        setUseOrganizationAddress(false)
        if (new URLSearchParams(window.location.search).get('crmAction') === 'compose-email') {
          if (!textValue(matched, 'email')) {
            setError('This CRM record has no primary email address.')
          } else if (emailOptedOut(matched)) {
            setError('This CRM record is marked Do not email.')
          } else if (payload.pipeline?.accessRole === 'viewer') {
            setError('This CRM record is view-only.')
          } else {
            const recordName = textValue(matched, 'fullName') || textValue(matched, 'name')
              || textValue(matched, 'referenceCode')
            setActionFields({ subject: `Follow-up: ${recordName}`, text: '' })
            setActionComposer({ type: 'send_email', record: matched })
          }
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load CRM records')
      setRecords([])
      setCanManageProductIdentities(false)
    } finally {
      setLoading(false)
    }
  }, [dateTimeSettings.timeZone, organizationCurrencyCode])

  const downloadCrmCsvExport = useCallback(async () => {
    setDataTransferExporting(true)
    setError('')
    try {
      let part = 1
      let parts = 1
      do {
        const response = await fetch(
          `/api/crm/data-transfer?entity=${encodeURIComponent(entity)}&part=${part}`,
          { cache: 'no-store' },
        )
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as {
            error?: string
          }
          throw new Error(payload.error || 'Unable to export CRM records')
        }
        if (part === 1) {
          const reportedParts = Number(
            response.headers.get('X-ClawPilot-Export-Parts') || '1',
          )
          if (
            !Number.isSafeInteger(reportedParts)
            || reportedParts < 1
            || reportedParts > 100_000
          ) {
            throw new Error('CRM export returned an invalid segment count')
          }
          parts = reportedParts
        }
        const blob = await response.blob()
        downloadResponseFile(
          response,
          blob,
          `clawpilot-${entity}-part-${part}-of-${parts}.csv`,
        )
        part += 1
      } while (part <= parts)
      setNotice(parts === 1
        ? `${ENTITY_LABELS[entity]} exported to CSV.`
        : `${ENTITY_LABELS[entity]} exported in ${parts} import-ready CSV files.`)
    } catch (exportError) {
      setError(exportError instanceof Error
        ? exportError.message
        : 'Unable to export CRM records')
    } finally {
      setDataTransferExporting(false)
    }
  }, [entity])

  useEffect(() => {
    if (
      currencyPreferenceReady
      || editorEntity !== 'products'
      || editorRecord !== null
    ) return
    setEditorRecord(undefined)
    setFields({})
  }, [currencyPreferenceReady, editorEntity, editorRecord])

  useEffect(() => {
    let cancelled = false
    const prepareRoute = async () => {
      const parameters = new URLSearchParams(window.location.search)
      const pipelineId = parameters.get('pipeline')?.trim() || ''
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pipelineId)) {
        await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'select-pipeline', pipelineId }),
        }).catch(() => null)
      }
      if (cancelled) return
      const reference = parameters.get('crm')?.trim().toLowerCase() || ''
      const linkedEntity = entityForReference(reference)
      if (linkedEntity) {
        setEntity(linkedEntity)
        setQuery(reference)
        setRouteQuery(reference)
      }
      setRouteReady(true)
    }
    void prepareRoute()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (routeReady) void load(entity, routeQuery, needsReviewOnly)
  }, [entity, load, needsReviewOnly, routeQuery, routeReady])

  useEffect(() => {
    let cancelled = false
    const loadCrmDropdowns = async () => {
      try {
        const response = await fetch('/api/pipeline/dropdowns')
        const payload = await response.json().catch(() => ({}))
        const valuesFor = (key: string) => (Array.isArray(payload?.catalog?.dropdowns?.[key])
          ? payload.catalog.dropdowns[key] as DropdownOption[]
          : [])
          .filter((option) => option.active !== false)
          .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0))
          .map((option) => String(option.label || option.value || '').trim())
          .filter(Boolean)
        const priorities = valuesFor('priority')
        const organizationTypes = valuesFor('account_type')
        if (!cancelled && priorities.length > 0) setPriorityOptions(priorities)
        if (!cancelled && organizationTypes.length > 0) setOrganizationTypeOptions(organizationTypes)
      } catch {
        // Base CRM catalogs remain usable when the optional Sheet catalog is unavailable.
      }
    }
    void loadCrmDropdowns()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (editorRecord === undefined) return
    let cancelled = false
    const loadEditorOptions = async () => {
      const loadingRelatedContacts = editorEntity === 'organizations' && Boolean(editorRecord)
      const loadingRelatedActivity = Boolean(editorRecord) && (editorEntity === 'leads' || editorEntity === 'campaigns')
      setRelatedContactsLoading(loadingRelatedContacts)
      setRelatedActivityLoading(loadingRelatedActivity)
      if (loadingRelatedActivity) {
        setRelatedActivity([])
        setCampaignRecipients([])
      }
      try {
        if (loadingRelatedContacts) {
          const contactRecords = await loadCrmOptions('contacts')
          if (!cancelled) setContacts(contactRecords)
        }
        if (editorRecord && (editorEntity === 'organizations' || editorEntity === 'contacts')) {
          const opportunityRecords = await loadCrmOptions('opportunities')
          if (!cancelled) setOpportunities(opportunityRecords)
        }
        if (['contacts', 'leads', 'meetings', 'interactions'].includes(editorEntity)) {
          const organizationRecords = await loadCrmOptions('organizations')
          if (!cancelled) setOrganizations(organizationRecords)
        }
        if (editorEntity === 'interactions') {
          const [contactRecords, leadRecords, opportunityRecords, campaignRecords] = await Promise.all([
            loadCrmOptions('contacts'),
            loadCrmOptions('leads'),
            loadCrmOptions('opportunities'),
            loadCrmOptions('campaigns'),
          ])
          if (!cancelled) setContacts(contactRecords)
          if (!cancelled) {
            setLeads(leadRecords)
            setOpportunities(opportunityRecords)
            setCampaigns(campaignRecords)
          }
        }
        if (editorEntity === 'meetings') {
          const [contactRecords, leadRecords, opportunityRecords] = await Promise.all([
            loadCrmOptions('contacts'),
            loadCrmOptions('leads'),
            loadCrmOptions('opportunities'),
          ])
          if (!cancelled) {
            setContacts(contactRecords)
            setLeads(leadRecords)
            setOpportunities(opportunityRecords)
          }
        }
        if (editorEntity === 'leads' && editorRecord
          && (editorRecord.convertedContactId || editorRecord.convertedOpportunityId)) {
          const [contactRecords, opportunityRecords] = await Promise.all([
            loadCrmOptions('contacts'),
            loadCrmOptions('opportunities'),
          ])
          if (!cancelled) {
            setContacts(contactRecords)
            setOpportunities(opportunityRecords)
          }
        }
        if (editorEntity === 'campaigns' && editorRecord) {
          const [contactRecords, leadRecords] = await Promise.all([
            loadCrmOptions('contacts'),
            loadCrmOptions('leads'),
          ])
          if (!cancelled) {
            setContacts(contactRecords)
            setLeads(leadRecords)
          }
        }
        if (loadingRelatedActivity && editorRecord) {
          const parameters = new URLSearchParams({
            entity: 'interactions',
            relatedEntity: editorEntity,
            relatedId: textValue(editorRecord, 'id'),
            limit: '100',
          })
          const response = await fetch(`/api/crm?${parameters}`)
          const payload = await response.json().catch(() => ({})) as CrmPayload
          if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to load CRM activity')
          if (!cancelled) {
            setRelatedActivity(annotateInteractionEventHistory(payload.records || []))
            setCampaignRecipients(payload.campaignRecipients || [])
          }
        }
      } catch (optionsError) {
        if (!cancelled) {
          setError(optionsError instanceof Error ? optionsError.message : 'Unable to load CRM relationship options')
        }
      } finally {
        if (!cancelled && loadingRelatedContacts) setRelatedContactsLoading(false)
        if (!cancelled && loadingRelatedActivity) setRelatedActivityLoading(false)
      }
    }
    void loadEditorOptions()
    return () => { cancelled = true }
  }, [editorEntity, editorRecord])

  const editable = Boolean(pipeline && pipeline.accessRole !== 'viewer' && entity !== 'opportunities')
  const canTransfer = Boolean(pipeline && pipeline.accessRole !== 'viewer')
  const canImportCsv = canTransfer && (
    entity === 'organizations'
    || entity === 'contacts'
    || entity === 'products'
    || entity === 'leads'
    || entity === 'opportunities'
  )
  const editorEditable = Boolean(pipeline && pipeline.accessRole !== 'viewer' && editorEntity !== 'opportunities')
  const convertedLead = editorEntity === 'leads'
    && Boolean(editorRecord?.convertedContactId || editorRecord?.convertedOpportunityId)
  const recordEditable = editorEditable
    && (editorEntity === 'products' || !editorRecord?.workspaceOrganizationId)
    && !convertedLead
  const tableColumns = useMemo(() => columns(entity), [entity])
  const relatedContacts = useMemo(() => {
    const organizationId = editorEntity === 'organizations' && editorRecord
      ? textValue(editorRecord, 'id')
      : ''
    if (!organizationId) return []
    return contacts
      .filter((contact) => textValue(contact, 'organizationId') === organizationId)
      .sort((left, right) => textValue(left, 'fullName').localeCompare(textValue(right, 'fullName')))
  }, [contacts, editorEntity, editorRecord])
  const interactionAgentEmail = useMemo(() => {
    if (fields.agentEmail) return fields.agentEmail
    const agentName = String(fields.agentName || '').trim().toLowerCase()
    if (!agentName) return ''
    return pipelineUsers.find((user) => (
      user.email.toLowerCase() === agentName || user.displayName.toLowerCase() === agentName
    ))?.email || ''
  }, [fields.agentEmail, fields.agentName, pipelineUsers])
  const contactOwnerSelection = fields.ownerUserReferenceCode
    || (editorEntity === 'contacts' && fields.accountManager ? LEGACY_CONTACT_OWNER : '')
  const organizationOwner = editorEntity === 'organizations' && fields.accountManager
    ? pipelineUsers.find((user) => (
      user.displayName.trim().toLowerCase() === fields.accountManager.trim().toLowerCase()
      || user.email.trim().toLowerCase() === fields.accountManager.trim().toLowerCase()
    ))
    : null
  const organizationOwnerSelection = organizationOwner?.referenceCode
    || (editorEntity === 'organizations' && fields.accountManager ? LEGACY_ORGANIZATION_OWNER : '')
  const relatedOrganization = useMemo(() => {
    if (editorEntity !== 'contacts' || !fields.organizationId) return null
    return organizations.find((organization) => textValue(organization, 'id') === fields.organizationId) || null
  }, [editorEntity, fields.organizationId, organizations])
  const relatedOpportunities = useMemo(() => {
    if (!editorRecord || (editorEntity !== 'organizations' && editorEntity !== 'contacts')) return []
    const recordId = textValue(editorRecord, 'id')
    return opportunities
      .filter((opportunity) => editorEntity === 'organizations'
        ? textValue(opportunity, 'organizationId') === recordId
        : Array.isArray(opportunity.contactIds) && opportunity.contactIds.map(String).includes(recordId))
      .sort((left, right) => textValue(left, 'name').localeCompare(textValue(right, 'name')))
  }, [editorEntity, editorRecord, opportunities])
  const convertedContact = useMemo(() => {
    if (!editorRecord?.convertedContactId) return null
    return contacts.find((contact) => textValue(contact, 'id') === textValue(editorRecord, 'convertedContactId')) || null
  }, [contacts, editorRecord])
  const convertedOrganization = useMemo(() => {
    if (!editorRecord?.organizationId) return null
    return organizations.find((organization) => (
      textValue(organization, 'id') === textValue(editorRecord, 'organizationId')
    )) || null
  }, [editorRecord, organizations])
  const convertedOpportunity = useMemo(() => {
    if (!editorRecord?.convertedOpportunityId) return null
    return opportunities.find((opportunity) => (
      textValue(opportunity, 'id') === textValue(editorRecord, 'convertedOpportunityId')
    )) || null
  }, [editorRecord, opportunities])
  const actionReady = Boolean(actionComposer && (
    actionComposer.type === 'send_email'
      ? actionFields.subject?.trim() && actionFields.text?.trim()
      : actionComposer.type === 'log_call'
        ? actionFields.subject?.trim()
        : actionComposer.type === 'create_calendar_event'
          ? actionFields.subject?.trim() && actionFields.startsAt && actionFields.endsAt
          : actionFields.recipientReferences?.trim() && actionFields.subject?.trim() && actionFields.text?.trim()
  ))

  function openEditor(record: RecordValue | null) {
    if (!record && !editable) return
    if (!record && entity === 'products' && !currencyPreferenceReady) return
    setEditorEntity(entity)
    setEditorHistory([])
    setEditorRecord(record)
    setFields(initialFields(
      entity,
      record,
      dateTimeSettings.timeZone,
      organizationCurrencyCode,
    ))
    setUseOrganizationAddress(false)
    setRelatedContactsLoading(entity === 'organizations' && Boolean(record))
  }

  function showNeedsReviewInteractions() {
    deepLinkOpened.current = true
    setEntity('interactions')
    setNeedsReviewOnly(true)
    setQuery('')
    setRouteQuery('')
  }

  function clearNeedsReviewFilter() {
    setNeedsReviewOnly(false)
    setQuery('')
    setRouteQuery('')
  }

  function openRelatedContact(record: RecordValue) {
    if (!editorRecord) return
    setEditorHistory((history) => [...history, { entity: editorEntity, record: editorRecord, fields }])
    setEditorEntity('contacts')
    setEditorRecord(record)
    setFields(initialFields(
      'contacts',
      record,
      dateTimeSettings.timeZone,
      organizationCurrencyCode,
    ))
    setUseOrganizationAddress(false)
    setRelatedContactsLoading(false)
  }

  function openRelatedOrganization(record: RecordValue) {
    if (!editorRecord) return
    const previous = editorHistory[editorHistory.length - 1]
    if (previous?.entity === 'organizations' && textValue(previous.record, 'id') === textValue(record, 'id')) {
      returnToPreviousEditor()
      return
    }
    setEditorHistory((history) => [...history, { entity: editorEntity, record: editorRecord, fields }])
    setEditorEntity('organizations')
    setEditorRecord(record)
    setFields(initialFields(
      'organizations',
      record,
      dateTimeSettings.timeZone,
      organizationCurrencyCode,
    ))
    setUseOrganizationAddress(false)
    setRelatedContactsLoading(true)
  }

  function openRelatedOpportunity(record: RecordValue) {
    if (!editorRecord) return
    setEditorHistory((history) => [...history, { entity: editorEntity, record: editorRecord, fields }])
    setEditorEntity('opportunities')
    setEditorRecord(record)
    setFields(initialFields(
      'opportunities',
      record,
      dateTimeSettings.timeZone,
      organizationCurrencyCode,
    ))
    setUseOrganizationAddress(false)
    setRelatedContactsLoading(false)
  }

  function openRelatedInteraction(record: RecordValue) {
    if (!editorRecord) return
    setEditorHistory((history) => [...history, { entity: editorEntity, record: editorRecord, fields }])
    setEditorEntity('interactions')
    setEditorRecord(record)
    setFields(initialFields(
      'interactions',
      record,
      dateTimeSettings.timeZone,
      organizationCurrencyCode,
    ))
    setUseOrganizationAddress(false)
    setRelatedContactsLoading(false)
    setRelatedActivityLoading(false)
  }

  function returnToPreviousEditor() {
    const previous = editorHistory[editorHistory.length - 1]
    if (!previous) return
    setEditorHistory(editorHistory.slice(0, -1))
    setEditorEntity(previous.entity)
    setEditorRecord(previous.record)
    setFields(previous.fields)
    setUseOrganizationAddress(false)
    setRelatedContactsLoading(previous.entity === 'organizations')
  }

  function closeEditor() {
    if (busy) return
    setEditorRecord(undefined)
    setUseOrganizationAddress(false)
    setEditorHistory([])
    setRelatedContactsLoading(false)
    setRelatedActivityLoading(false)
  }

  function openLifecycleDialog(type: LifecycleDialog['type'], record: RecordValue) {
    if (type === 'convert-lead') {
      const accountName = textValue(record, 'organizationName') || textValue(record, 'companyName')
        || `${textValue(record, 'fullName')} Account`
      setLifecycleFields({
        accountName,
        opportunityName: `${accountName} - ${textValue(record, 'fullName')}`,
        opportunityValue: '0',
      })
    } else {
      setLifecycleFields({})
    }
    setLifecycleDialog({ type, record })
  }

  async function submitLifecycleAction() {
    if (!lifecycleDialog) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/crm', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: lifecycleDialog.type,
          entity: editorEntity,
          id: lifecycleDialog.record.id,
          ...(lifecycleDialog.type === 'convert-lead' ? {
            fields: {
              accountName: lifecycleFields.accountName,
              opportunityName: lifecycleFields.opportunityName,
              opportunityValue: Number(lifecycleFields.opportunityValue || 0),
            },
          } : {}),
        }),
      })
      const payload = await response.json().catch(() => ({})) as CrmLifecyclePayload
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'CRM lifecycle action failed')
      const wasConversion = lifecycleDialog.type === 'convert-lead'
      setLifecycleDialog(null)
      setEditorRecord(undefined)
      setUseOrganizationAddress(false)
      setEditorHistory([])
      setNotice(wasConversion
        ? `Lead converted to ${payload.result?.accountReferenceCode}, ${payload.result?.contactReferenceCode}, and ${payload.result?.opportunityReferenceCode}`
        : `${ENTITY_LABELS[editorEntity].slice(0, -1)} archived`)
      await load(entity, query, needsReviewOnly)
    } catch (lifecycleError) {
      setError(lifecycleError instanceof Error ? lifecycleError.message : 'CRM lifecycle action failed')
    } finally {
      setBusy(false)
    }
  }

  async function saveRecord() {
    if (editorRecord === undefined) return
    setBusy(true)
    setError('')
    try {
      const occurredAt = editorEntity === 'interactions' && fields.occurredAt
        ? zonedDateTimeToIso(fields.occurredAt, dateTimeSettings.timeZone)
        : null
      if (editorEntity === 'interactions' && fields.occurredAt && !occurredAt) {
        throw new Error('Interaction date is invalid in your profile timezone')
      }
      const response = await fetch('/api/crm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: editorEntity,
          id: editorRecord?.id,
          fields: editorEntity === 'meetings'
            ? { ...fields, attendeeEmails: fields.attendeeEmails?.split(',').map((email) => email.trim()).filter(Boolean) || [] }
            : editorEntity === 'interactions'
              ? {
                  ...fields,
                  contactIds: idList(fields.contactIds),
                  contactId: idList(fields.contactIds)[0] || '',
                  agentEmail: interactionAgentEmail,
                  occurredAt,
                }
              : editorEntity === 'products'
                ? {
                    ...fields,
                    active: fields.active !== 'false',
                    price: Number(fields.price || 0),
                    cost: Number(fields.cost || 0),
                  }
              : editorEntity === 'contacts'
                ? contactFieldsForSave(fields)
              : ['organizations', 'leads'].includes(editorEntity)
                ? { ...fields, emailOptOut: fields.emailOptOut === 'true' }
                : fields,
        }),
      })
      const payload = await response.json().catch(() => ({})) as CrmPayload
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to save CRM record')
      setEditorRecord(undefined)
      setEditorHistory([])
      setNotice('Saved and queued for CRM sync')
      await load(entity, query, needsReviewOnly)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save CRM record')
    } finally {
      setBusy(false)
    }
  }

  function openAction(type: CrmActionType, record: RecordValue) {
    const recordName = textValue(record, 'fullName') || textValue(record, 'name')
      || textValue(record, 'subject') || textValue(record, 'referenceCode')
    if (type === 'send_email') {
      if (!textValue(record, 'email') || emailOptedOut(record)) return
      setActionFields({ subject: `Follow-up: ${recordName}`, text: '' })
    } else if (type === 'create_calendar_event') {
      const timezone = textValue(record, 'timezone') || 'America/New_York'
      setActionFields({
        subject: textValue(record, 'subject') || `Meeting with ${recordName}`,
        description: textValue(record, 'description'),
        startsAt: dateTimeLocalValue(record.startsAt, timezone),
        endsAt: dateTimeLocalValue(record.endsAt, timezone),
        timezone,
        location: textValue(record, 'location'),
        attendeeEmails: Array.isArray(record.attendeeEmails)
          ? record.attendeeEmails.map(String).join(', ')
          : textValue(record, 'email'),
      })
    } else if (type === 'log_call') {
      setActionFields({
        subject: `Call ${recordName}`,
        notes: '',
        activityStatus: 'held',
        durationMinutes: '15',
        direction: 'outbound',
      })
    } else {
      setActionFields({
        recipientReferences: '',
        subject: textValue(record, 'subjectTemplate'),
        text: textValue(record, 'bodyTemplate'),
      })
    }
    setActionComposer({ type, record })
  }

  async function submitAction() {
    if (!actionComposer) return
    setBusy(true)
    setError('')
    try {
      const payload = actionComposer.type === 'send_email'
        ? { subject: actionFields.subject, text: actionFields.text }
        : actionComposer.type === 'log_call'
          ? {
              subject: actionFields.subject,
              notes: actionFields.notes,
              activityStatus: actionFields.activityStatus,
              durationMinutes: Number(actionFields.durationMinutes || 15),
              direction: actionFields.direction,
            }
          : actionComposer.type === 'create_calendar_event'
            ? {
                subject: actionFields.subject,
                description: actionFields.description,
                startsAt: actionFields.startsAt,
                endsAt: actionFields.endsAt,
                timezone: actionFields.timezone,
                location: actionFields.location,
                attendeeEmails: actionFields.attendeeEmails?.split(',').map((email) => email.trim()).filter(Boolean) || [],
              }
            : {
                recipientReferences: actionFields.recipientReferences?.split(/[\s,]+/).filter(Boolean) || [],
                subject: actionFields.subject,
                text: actionFields.text,
              }
      const response = await fetch('/api/crm/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: actionComposer.type,
          referenceCode: textValue(actionComposer.record, 'referenceCode'),
          payload,
          idempotencyKey: `crm-ui:${actionComposer.type}:${crypto.randomUUID()}`,
          processNow: true,
        }),
      })
      const result = await response.json().catch(() => ({})) as CrmActionPayload
      if (!response.ok || !result.ok) throw new Error(result.error || 'CRM action failed')
      if (result.action?.status === 'failed' || result.action?.status === 'dead') {
        throw new Error(result.action.lastError || 'CRM action could not be completed')
      }
      const telUrl = String(result.action?.responseSummary?.telUrl || '')
      setActionComposer(null)
      setNotice(result.action?.status === 'succeeded' ? 'CRM action completed and logged' : 'CRM action queued')
      if (actionComposer.type === 'log_call' && /^tel:[0-9+*#,;]+$/.test(telUrl)) window.location.href = telUrl
      if (entity === 'interactions' || entity === 'meetings' || entity === 'campaigns') await load(entity, query, needsReviewOnly)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'CRM action failed')
    } finally {
      setBusy(false)
    }
  }

  async function runWorkbookAction(path: string, success: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(path, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as CrmPayload
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Workbook action failed')
      setNotice(success)
      await load(entity, query, needsReviewOnly)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Workbook action failed')
    } finally {
      setBusy(false)
    }
  }

  async function updateHierarchyParent(organizationId: string, parentId: string) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/crm/hierarchy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, parentId }),
      })
      const payload = await response.json().catch(() => ({})) as CrmPayload
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to update organization hierarchy')
      setWorkspaceHierarchy(payload.workspaceHierarchy || payload.hierarchy || [])
      setNotice('Organization hierarchy updated')
      await load(entity, query, needsReviewOnly)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update organization hierarchy')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ px: shortLandscape ? 1 : { xs: 2, md: 3 }, pt: shortLandscape ? 0.5 : 2.5, pb: shortLandscape ? 0.5 : 1.5, flexShrink: 0 }}>
        <Stack direction={shortLandscape ? 'row' : { xs: 'column', lg: 'row' }} justifyContent="space-between" gap={shortLandscape ? 1 : 1.5} alignItems={shortLandscape ? 'center' : undefined}>
          <Box sx={{ flexShrink: 0 }}>
            <Typography variant="h5" fontWeight={700} sx={shortLandscape ? { fontSize: '1rem' } : undefined}>CRM</Typography>
            {!shortLandscape && <Typography variant="body2" color="text.secondary">{pipeline?.name || 'Customer records'}</Typography>}
          </Box>
          <Stack
            direction="row"
            gap={shortLandscape ? 0.5 : 1}
            alignItems="center"
            data-testid="crm-primary-actions"
            sx={{
              width: { xs: '100%', lg: 'auto' },
              minWidth: 0,
              ...(shortLandscape ? { overflowX: 'auto', WebkitOverflowScrolling: 'touch' } : {}),
              ...(!narrowMobile ? { '& > *': { flexShrink: 0 } } : {}),
            }}
          >
            <Box sx={narrowMobile ? { flex: '1 1 0', minWidth: 0, '& .MuiFormControl-root': { width: '100%', maxWidth: '100%' } } : undefined}>
              <WorkspaceSelector kind="pipeline" />
            </Box>
            {workspaceHierarchy.length > 0 && (
              narrowMobile ? (
                <Tooltip title="Organization hierarchy">
                  <IconButton aria-label="Organization hierarchy" color="primary" onClick={() => setHierarchyOpen(true)}>
                    <AccountTreeRounded />
                  </IconButton>
                </Tooltip>
              ) : (
                <Button
                  startIcon={<AccountTreeRounded />}
                  variant="outlined"
                  onClick={() => setHierarchyOpen(true)}
                >
                  Hierarchy
                </Button>
              )
            )}
            {pipeline?.shortLinkUrl && (
              narrowMobile ? (
                <Tooltip title="Open workbook">
                  <IconButton
                    component="a"
                    href={pipeline.shortLinkUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open workbook"
                    color="primary"
                  >
                    <OpenInNewRounded />
                  </IconButton>
                </Tooltip>
              ) : (
                <Button
                  component="a"
                  href={pipeline.shortLinkUrl}
                  target="_blank"
                  rel="noreferrer"
                  startIcon={<OpenInNewRounded />}
                  variant="outlined"
                >
                  Workbook
                </Button>
              )
            )}
            {suiteCrmPunchoutUrl && (
              narrowMobile ? (
                <Tooltip title="Open SuiteCRM">
                  <IconButton aria-label="Open SuiteCRM" color="primary" onClick={() => setSuiteCrmAccessOpen(true)}>
                    <OpenInNewRounded />
                  </IconButton>
                </Tooltip>
              ) : (
                <Button
                  startIcon={<OpenInNewRounded />}
                  variant="outlined"
                  onClick={() => setSuiteCrmAccessOpen(true)}
                >
                  Open SuiteCRM
                </Button>
              )
            )}
          </Stack>
        </Stack>
        <Stack
          direction="row"
          gap={shortLandscape ? 0.5 : 1}
          mt={shortLandscape ? 0.5 : 2}
          data-testid="crm-summary-strip"
          sx={{
            maxWidth: '100%',
            overflowX: 'auto',
            pb: shortLandscape ? 0 : 0.5,
            scrollbarWidth: 'thin',
            WebkitOverflowScrolling: 'touch',
            '& .MuiChip-root': { flexShrink: 0 },
          }}
        >
          <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.organizations} organizations`} />
          <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.contacts} contacts`} />
          <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.leads} leads`} />
          <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.opportunities} opportunities`} />
          <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.products} products`} />
          <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.meetings} meetings`} />
          <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.interactions} interactions`} />
          {summary.needsReviewInteractions > 0 && (
            <Chip
              size={shortLandscape ? 'small' : 'medium'}
              label={`${summary.needsReviewInteractions} needs review`}
              color="warning"
              variant={needsReviewOnly ? 'filled' : 'outlined'}
              clickable
              onClick={showNeedsReviewInteractions}
              sx={{ flexShrink: 0 }}
            />
          )}
          <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.campaigns} campaigns`} />
          <Chip size={shortLandscape ? 'small' : 'medium'} label={money(summary.openPipelineValue)} color="primary" variant="outlined" />
          {summary.pendingSync > 0 && <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.pendingSync} syncing`} color="warning" />}
          {summary.failedSync > 0 && <Chip size={shortLandscape ? 'small' : 'medium'} label={`${summary.failedSync} failed`} color="error" />}
        </Stack>
      </Box>
      <Divider />
      <Box sx={{ px: shortLandscape ? 1 : { xs: 2, md: 3 }, pt: shortLandscape ? 0.25 : 1.25, flexShrink: 0 }}>
        {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 1 }}>{notice}</Alert>}
        {entity === 'products' && !currencyPreferenceReady ? (
          <Alert
            severity={measurementPreferencesError ? 'warning' : 'info'}
            sx={{ mb: 1 }}
            action={!measurementPreferencesLoading ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => { void refreshMeasurementPreferences() }}
              >
                Retry
              </Button>
            ) : undefined}
          >
            {measurementPreferencesLoading
              ? 'Loading the organization currency before a new Product can be added.'
              : measurementPreferencesError
                || 'Choose an active organization before adding a Product.'}
          </Alert>
        ) : null}
        <Stack direction={shortLandscape ? 'row' : 'column'} gap={shortLandscape ? 0.75 : 0} alignItems={shortLandscape ? 'center' : 'stretch'} sx={shortLandscape ? { overflowX: 'auto', WebkitOverflowScrolling: 'touch' } : undefined}>
          <Stack
            direction={shortLandscape ? 'row' : { xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            gap={shortLandscape ? 1 : { xs: 0.5, sm: 1 }}
            alignItems={shortLandscape ? 'center' : { xs: 'stretch', sm: 'center' }}
            sx={{ minWidth: 0, flexShrink: 0 }}
          >
            <Tabs value={entity} aria-label="CRM record types" onChange={(_, value: CrmEntity) => {
              deepLinkOpened.current = true
              setEntity(value)
              setNeedsReviewOnly(false)
              setQuery('')
              setRouteQuery('')
            }} variant="scrollable" sx={shortLandscape
              ? { minHeight: 36, maxWidth: 420, '& .MuiTab-root': { minHeight: 36, py: 0.5 } }
              : { width: { xs: '100%', sm: 'auto' }, maxWidth: '100%' }}>
              {(Object.keys(ENTITY_LABELS) as CrmEntity[]).map((value) => (
                <Tab key={value} value={value} label={ENTITY_LABELS[value]} />
              ))}
            </Tabs>
            <Stack data-testid="crm-record-actions" direction="row" gap={0.75} alignItems="center" sx={{ flexShrink: 0, alignSelf: { xs: 'flex-end', sm: 'auto' } }}>
              {canTransfer && (
                <Tooltip title={`Export ${ENTITY_LABELS[entity].toLowerCase()} CSV`}>
                  <IconButton
                    aria-label={`Export ${ENTITY_LABELS[entity]} CSV`}
                    disabled={dataTransferExporting}
                    onClick={() => { void downloadCrmCsvExport() }}
                  >
                    {dataTransferExporting
                      ? <CircularProgress size={20} />
                      : <DownloadRounded />}
                  </IconButton>
                </Tooltip>
              )}
              {canImportCsv && (
                <Tooltip title={`Import ${ENTITY_LABELS[entity].toLowerCase()} CSV`}>
                  <IconButton
                    aria-label={`Import ${ENTITY_LABELS[entity]} CSV`}
                    disabled={busy}
                    onClick={() => setDataTransferOpen(true)}
                  >
                    <UploadFileRounded />
                  </IconButton>
                </Tooltip>
              )}
              {entity === 'products'
                && canTransfer
                && canManageProductIdentities ? (
                <Tooltip title="Resolve duplicate sales-channel product identities">
                  <IconButton
                    aria-label="Resolve duplicate product identities"
                    disabled={busy}
                    onClick={() => setProductIdentityOpen(true)}
                  >
                    <CallMergeRounded />
                  </IconButton>
                </Tooltip>
              ) : null}
              {pipeline?.accessRole === 'owner' && (
                <>
                  <Tooltip title="Import the connected workbook into CRM">
                    <IconButton aria-label="Import workbook" disabled={busy} onClick={() => runWorkbookAction('/api/crm/import', 'Workbook imported and queued for CRM sync')}>
                      <UploadFileRounded />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Refresh workbook from CRM">
                    <IconButton aria-label="Refresh workbook" disabled={busy} onClick={() => runWorkbookAction('/api/crm/workbook', 'Workbook refreshed from CRM')}>
                      <RefreshRounded />
                    </IconButton>
                  </Tooltip>
                </>
              )}
              {editable && (
                <Button
                  variant="contained"
                  startIcon={<AddRounded />}
                  disabled={entity === 'products' && !currencyPreferenceReady}
                  onClick={() => openEditor(null)}
                >
                  Add
                </Button>
              )}
            </Stack>
          </Stack>
          {entity === 'interactions' && needsReviewOnly && (
            <Chip
              label="Needs review only"
              color="warning"
              variant="outlined"
              size="small"
              onDelete={clearNeedsReviewFilter}
              sx={{ alignSelf: 'flex-start', mt: shortLandscape ? 0 : 1.25, flexShrink: 0 }}
            />
          )}
          <TextField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void load(entity, query, needsReviewOnly) }}
            placeholder={`Search ${ENTITY_LABELS[entity].toLowerCase()}`}
            size="small"
            fullWidth={!shortLandscape}
            sx={{ mt: shortLandscape ? 0 : 1.25, mb: shortLandscape ? 0.25 : 1, width: shortLandscape ? 220 : undefined, flexShrink: 0 }}
            InputProps={{
              startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment>,
              endAdornment: query ? <InputAdornment position="end"><IconButton size="small" aria-label="Run search" onClick={() => load(entity, query, needsReviewOnly)}><SearchRounded fontSize="small" /></IconButton></InputAdornment> : undefined,
            }}
          />
        </Stack>
      </Box>
      <TableContainer data-testid="crm-records" tabIndex={0} aria-label="CRM records" sx={{ flex: 1, minHeight: shortLandscape ? 96 : 0, px: { xs: 0, md: 3 }, overflow: 'auto' }}>
        {loading ? (
          <Box display="grid" sx={{ placeItems: 'center', height: 240 }}><CircularProgress size={28} /></Box>
        ) : (
          <Table stickyHeader size="small" sx={{
            minWidth: 720,
            '& th:first-of-type, & td:first-of-type': {
              position: 'sticky',
              left: 0,
              zIndex: 2,
              backgroundColor: 'background.paper',
              boxShadow: '1px 0 0 0 rgba(255, 255, 255, 0.12)',
            },
            '& th:first-of-type': { zIndex: 4 },
          }}>
            <TableHead>
              <TableRow>
                {tableColumns.map(([, label]) => <TableCell key={label}>{label}</TableCell>)}
                <TableCell width={110}>Sync</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {records.map((record) => (
                <TableRow
                  key={textValue(record, 'id')}
                  hover
                  onClick={() => { void openEditor(record) }}
                  sx={{ cursor: 'pointer' }}
                >
                  {tableColumns.map(([key]) => (
                    <TableCell key={key}>
                      {key === 'referenceCode' && record.shortUrl ? (
                        <Link
                          href={textValue(record, 'shortUrl')}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          underline="hover"
                        >
                          {textValue(record, key)}
                        </Link>
                      ) : entity === 'products' && key === 'price'
                        ? productMoney(record[key], textValue(record, 'currency'))
                        : entity === 'products' && key === 'salesChannels'
                          ? (
                            <Stack
                              direction="row"
                              gap={0.5}
                              flexWrap="wrap"
                              sx={{ minWidth: 150 }}
                            >
                              {productSalesChannels(record).map((channel) => (
                                <Tooltip
                                  key={channel.id}
                                  title={`${channel.integrationAccountName} · Connection ${channel.integrationAccountStatus}`}
                                >
                                  <Chip
                                    size="small"
                                    variant="outlined"
                                    color={salesChannelStatusColor(
                                      channel.normalizedStatus,
                                    )}
                                    label={`${providerLabel(channel.provider)} · ${salesChannelStatusLabel(channel.normalizedStatus)}`}
                                  />
                                </Tooltip>
                              ))}
                              {productSalesChannels(record).length === 0 ? (
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  label="Local only"
                                />
                              ) : null}
                            </Stack>
                          )
                        : entity === 'opportunities' && key === 'value'
                          ? money(record[key])
                        : displayValue(record, key, dateTimeSettings)}
                    </TableCell>
                  ))}
                  <TableCell>
                    <Chip
                      size="small"
                      label={textValue(record, 'syncStatus') || 'pending'}
                      color={record.syncStatus === 'failed' ? 'error' : record.syncStatus === 'synced' ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                </TableRow>
              ))}
              {records.length === 0 && (
                <TableRow><TableCell colSpan={tableColumns.length + 1} align="center" sx={{ py: 6, color: 'text.secondary' }}>No records</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </TableContainer>

      <CrmDataTransferDialog
        open={dataTransferOpen}
        entity={entity}
        onClose={() => setDataTransferOpen(false)}
        onApplied={async (count, warnings) => {
          const warningText = warnings.length > 0
            ? ` ${warnings.join(' ')}`
            : ''
          setNotice(`${count} CRM record${count === 1 ? '' : 's'} imported and queued for sync.${warningText}`)
          await load(entity, query, needsReviewOnly)
        }}
      />

      <ProductIdentityDialog
        open={productIdentityOpen}
        onClose={() => setProductIdentityOpen(false)}
        onChanged={async () => {
          await load(entity, query, needsReviewOnly)
        }}
      />

      <Dialog
        open={suiteCrmAccessOpen}
        onClose={() => setSuiteCrmAccessOpen(false)}
        fullScreen={shortLandscape}
        fullWidth
        maxWidth="xs"
        PaperProps={{ sx: { backgroundColor: '#1A1A23', backgroundImage: 'none', borderRadius: '8px' } }}
      >
        <DialogTitle>SuiteCRM sign in</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={0.5}>
            <TextField
              label="Username"
              value={suiteCrmUsername || 'admin'}
              size="small"
              fullWidth
              InputProps={{ readOnly: true }}
            />
            <TextField
              label="Password"
              value="SUITECRM_ADMIN_PASSWORD"
              size="small"
              fullWidth
              InputProps={{ readOnly: true }}
            />
            <Typography variant="caption" color="text.secondary">
              The password is a protected Railway secret and is never returned to the browser.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: shortLandscape ? 1.5 : 3, pb: shortLandscape ? 1.5 : 2.5, flexWrap: 'wrap' }}>
          <Button onClick={() => setSuiteCrmAccessOpen(false)}>Cancel</Button>
          {suiteCrmAdminPortalUrl ? (
            <Button component="a" href={suiteCrmAdminPortalUrl} target="_blank" rel="noopener noreferrer">
              Password settings
            </Button>
          ) : null}
          <Button
            component="a"
            href={suiteCrmPunchoutUrl || '#'}
            target="_blank"
            rel="noopener noreferrer"
            variant="contained"
            startIcon={<OpenInNewRounded />}
            onClick={() => setSuiteCrmAccessOpen(false)}
          >
            Open SuiteCRM
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(actionComposer)}
        onClose={() => { if (!busy) setActionComposer(null) }}
        fullScreen={shortLandscape}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {actionComposer?.type === 'send_email' ? 'Send email'
            : actionComposer?.type === 'log_call' ? 'Call and log interaction'
              : actionComposer?.type === 'create_calendar_event' ? 'Schedule meeting'
                : 'Send campaign'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={0.5}>
            {actionComposer?.type === 'send_email' && <>
              <TextField disabled label="From" value={providerIdentities.googleMail || 'Select Google Mail in Settings'} />
              <TextField label="Subject" required value={actionFields.subject || ''} onChange={(event) => setActionFields({ ...actionFields, subject: event.target.value })} />
              <TextField label="Message" required multiline minRows={8} value={actionFields.text || ''} onChange={(event) => setActionFields({ ...actionFields, text: event.target.value })} />
            </>}
            {actionComposer?.type === 'log_call' && <>
              <TextField label="Subject" required value={actionFields.subject || ''} onChange={(event) => setActionFields({ ...actionFields, subject: event.target.value })} />
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField fullWidth select label="Status" value={actionFields.activityStatus || 'held'} onChange={(event) => setActionFields({ ...actionFields, activityStatus: event.target.value })}>
                  {ACTIVITY_STATUSES.map((status) => <MenuItem key={status.value} value={status.value}>{status.label}</MenuItem>)}
                </TextField>
                <TextField fullWidth select label="Direction" value={actionFields.direction || 'outbound'} onChange={(event) => setActionFields({ ...actionFields, direction: event.target.value })}>
                  <MenuItem value="outbound">Outbound</MenuItem>
                  <MenuItem value="inbound">Inbound</MenuItem>
                </TextField>
                <TextField
                  fullWidth
                  label="Duration (minutes)"
                  type="number"
                  inputProps={{ min: 1, max: 1440, step: 1 }}
                  value={actionFields.durationMinutes || '15'}
                  onChange={(event) => setActionFields({ ...actionFields, durationMinutes: event.target.value })}
                />
              </Stack>
              <TextField label="Call notes" multiline minRows={5} value={actionFields.notes || ''} onChange={(event) => setActionFields({ ...actionFields, notes: event.target.value })} />
            </>}
            {actionComposer?.type === 'create_calendar_event' && <>
              <TextField disabled label="Calendar organizer" value={providerIdentities.googleCalendar || 'Select Google Calendar in Settings'} />
              <TextField label="Meeting" required value={actionFields.subject || ''} onChange={(event) => setActionFields({ ...actionFields, subject: event.target.value })} />
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField fullWidth label="Starts" type="datetime-local" required value={actionFields.startsAt || ''} onChange={(event) => setActionFields({ ...actionFields, startsAt: event.target.value })} InputLabelProps={{ shrink: true }} />
                <TextField fullWidth label="Ends" type="datetime-local" required value={actionFields.endsAt || ''} onChange={(event) => setActionFields({ ...actionFields, endsAt: event.target.value })} InputLabelProps={{ shrink: true }} />
              </Stack>
              <TextField label="Timezone" value={actionFields.timezone || ''} onChange={(event) => setActionFields({ ...actionFields, timezone: event.target.value })} />
              <TextField label="Attendee emails" value={actionFields.attendeeEmails || ''} onChange={(event) => setActionFields({ ...actionFields, attendeeEmails: event.target.value })} helperText="Separate addresses with commas" />
              <TextField label="Location" value={actionFields.location || ''} onChange={(event) => setActionFields({ ...actionFields, location: event.target.value })} />
              <TextField label="Description" multiline minRows={4} value={actionFields.description || ''} onChange={(event) => setActionFields({ ...actionFields, description: event.target.value })} />
            </>}
            {actionComposer?.type === 'send_campaign' && <>
              <TextField disabled label="From" value={providerIdentities.googleMail || 'Select Google Mail in Settings'} />
              <TextField label="Recipient CRM IDs" required value={actionFields.recipientReferences || ''} onChange={(event) => setActionFields({ ...actionFields, recipientReferences: event.target.value })} helperText="Use gc or gl IDs, separated by commas or spaces" />
              <TextField label="Subject template" required value={actionFields.subject || ''} onChange={(event) => setActionFields({ ...actionFields, subject: event.target.value })} />
              <TextField label="Message template" required multiline minRows={8} value={actionFields.text || ''} onChange={(event) => setActionFields({ ...actionFields, text: event.target.value })} helperText="Merge fields: {{firstName}}, {{lastName}}, {{name}}, {{email}}, {{referenceCode}}" />
            </>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setActionComposer(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" onClick={submitAction} disabled={busy || !actionReady}>
            {busy ? 'Working…' : actionComposer?.type === 'log_call' ? 'Call' : 'Send'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(lifecycleDialog)}
        onClose={() => { if (!busy) setLifecycleDialog(null) }}
        fullScreen={shortLandscape}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{lifecycleDialog?.type === 'convert-lead' ? 'Convert lead' : 'Archive record'}</DialogTitle>
        <DialogContent>
          {lifecycleDialog?.type === 'convert-lead' ? (
            <Stack spacing={2} mt={0.5}>
              <TextField
                label="Account"
                required
                value={lifecycleFields.accountName || ''}
                onChange={(event) => setLifecycleFields({ ...lifecycleFields, accountName: event.target.value })}
              />
              <TextField
                label="Opportunity"
                required
                value={lifecycleFields.opportunityName || ''}
                onChange={(event) => setLifecycleFields({ ...lifecycleFields, opportunityName: event.target.value })}
              />
              <TextField
                label="Opportunity value"
                type="number"
                inputProps={{ min: 0, step: '0.01' }}
                value={lifecycleFields.opportunityValue || '0'}
                onChange={(event) => setLifecycleFields({ ...lifecycleFields, opportunityValue: event.target.value })}
              />
            </Stack>
          ) : (
            <Typography mt={0.5}>
              Archive {textValue(lifecycleDialog?.record || {}, 'fullName')
                || textValue(lifecycleDialog?.record || {}, 'name')
                || textValue(lifecycleDialog?.record || {}, 'referenceCode')}?
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap' }}>
          <Button onClick={() => setLifecycleDialog(null)} disabled={busy}>Cancel</Button>
          <Button
            variant="contained"
            color={lifecycleDialog?.type === 'archive' ? 'error' : 'primary'}
            onClick={submitLifecycleAction}
            disabled={busy || (lifecycleDialog?.type === 'convert-lead'
              && (!lifecycleFields.accountName?.trim() || !lifecycleFields.opportunityName?.trim()))}
          >
            {busy ? 'Working…' : lifecycleDialog?.type === 'convert-lead' ? 'Convert' : 'Archive'}
          </Button>
        </DialogActions>
      </Dialog>

      <Drawer
        anchor="right"
        open={hierarchyOpen}
        onClose={() => { if (!busy) setHierarchyOpen(false) }}
        PaperProps={{ sx: { width: { xs: '100%', sm: 520 }, maxWidth: '100vw' } }}
      >
        <Box sx={{ p: 2.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" gap={1.25} alignItems="center">
            <AccountTreeRounded color="primary" />
            <Box>
              <Typography variant="h6" fontWeight={700}>Organization hierarchy</Typography>
              <Typography variant="body2" color="text.secondary">{workspaceHierarchy.length} organizations</Typography>
            </Box>
          </Stack>
          <IconButton aria-label="Close hierarchy" onClick={() => setHierarchyOpen(false)} disabled={busy}><CloseRounded /></IconButton>
        </Box>
        <Divider />
        <Stack divider={<Divider flexItem />} sx={{ overflowY: 'auto' }}>
          {workspaceHierarchy.map((organization) => {
            const excluded = hierarchyDescendants(workspaceHierarchy, organization.id)
            return (
              <Box key={organization.id} sx={{ py: 2, pr: 2.5, pl: 2.5 + Math.min(organization.depth, 5) * 2 }}>
                <Stack direction="row" gap={1.25} alignItems="flex-start">
                  <BusinessRounded color={organization.organizationType === 'root' ? 'primary' : 'action'} sx={{ mt: 0.25 }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                      <Typography fontWeight={700}>{organization.name}</Typography>
                      <Chip size="small" label={organization.organizationType === 'root' ? 'Root' : 'Member'} variant="outlined" />
                    </Stack>
                    {organization.members.map((member) => (
                      <Typography key={member.email} variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {member.displayName || member.email} · {member.role}
                      </Typography>
                    ))}
                    {canManageHierarchy && organization.organizationType !== 'root' && (
                      <TextField
                        select
                        label="Parent organization"
                        size="small"
                        value={organization.parentId || ''}
                        disabled={busy}
                        onChange={(event) => void updateHierarchyParent(organization.id, event.target.value)}
                        sx={{ mt: 1.5, width: '100%' }}
                      >
                        {workspaceHierarchy
                          .filter((candidate) => candidate.id !== organization.id && !excluded.has(candidate.id))
                          .map((candidate) => (
                            <MenuItem key={candidate.id} value={candidate.id}>{candidate.name}</MenuItem>
                          ))}
                      </TextField>
                    )}
                  </Box>
                </Stack>
              </Box>
            )
          })}
        </Stack>
      </Drawer>

      <Drawer
        anchor="right"
        open={editorRecord !== undefined}
        onClose={closeEditor}
        PaperProps={{ sx: { width: { xs: '100%', sm: 460 }, maxWidth: '100vw', overflowX: 'hidden' } }}
      >
        <Box sx={{ p: shortLandscape ? 1.5 : 2.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" gap={0.5} sx={{ minWidth: 0 }}>
            {editorHistory.length > 0 && (
              <Tooltip title={`Back to ${ENTITY_LABELS[editorHistory[editorHistory.length - 1].entity].slice(0, -1).toLowerCase()}`}>
                <IconButton aria-label={`Back to ${ENTITY_LABELS[editorHistory[editorHistory.length - 1].entity].slice(0, -1).toLowerCase()}`} onClick={returnToPreviousEditor} disabled={busy}>
                  <ArrowBackRounded />
                </IconButton>
              </Tooltip>
            )}
            <Typography variant="h6" fontWeight={700} sx={{ overflowWrap: 'anywhere' }}>
              {editorRecord ? 'Edit' : 'Add'} {ENTITY_LABELS[editorEntity].slice(0, -1)}
            </Typography>
          </Stack>
          <IconButton aria-label="Close editor" onClick={closeEditor} disabled={busy}><CloseRounded /></IconButton>
        </Box>
        <Divider />
        <Stack spacing={2} sx={{ p: shortLandscape ? 1.5 : 2.5, overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}>
          {editorRecord && Boolean(editorRecord.referenceCode) && (
            <Stack direction="row" gap={1} alignItems="center">
              <Chip label={textValue(editorRecord, 'referenceCode')} color="primary" variant="outlined" />
              {editorRecord.shortUrl ? (
                <Button
                  component="a"
                  href={textValue(editorRecord, 'shortUrl')}
                  target="_blank"
                  rel="noreferrer"
                  size="small"
                  endIcon={<OpenInNewRounded />}
                >
                  Open link
                </Button>
              ) : null}
            </Stack>
          )}
          {editorRecord && editorEditable && (
            <Stack direction="row" gap={1} flexWrap="wrap">
              {['organizations', 'contacts', 'leads'].includes(editorEntity) && Boolean(editorRecord.email) && (
                <Button disabled={emailOptedOut(editorRecord)} startIcon={<EmailRounded />} variant="outlined" onClick={() => openAction('send_email', editorRecord)}>
                  Email
                </Button>
              )}
              {Boolean(editorRecord.phone || editorRecord.phoneWork || editorRecord.phoneMobile) && (
                <Button startIcon={<PhoneRounded />} variant="outlined" onClick={() => openAction('log_call', editorRecord)}>
                  Call
                </Button>
              )}
              {!['interactions', 'campaigns', 'products'].includes(editorEntity) && (
                <Button startIcon={<EventRounded />} variant="outlined" onClick={() => openAction('create_calendar_event', editorRecord)}>
                  Schedule
                </Button>
              )}
              {editorEntity === 'campaigns' && (
                <Button startIcon={<CampaignRounded />} variant="outlined" onClick={() => openAction('send_campaign', editorRecord)}>
                  Send campaign
                </Button>
              )}
              {editorEntity === 'leads' && !convertedLead && (
                <Button startIcon={<SyncAltRounded />} variant="outlined" onClick={() => openLifecycleDialog('convert-lead', editorRecord)}>
                  Convert
                </Button>
              )}
              {(editorEntity === 'leads' || editorEntity === 'interactions' || editorEntity === 'campaigns') && (
                <Tooltip title={`Archive ${ENTITY_LABELS[editorEntity].slice(0, -1).toLowerCase()}`}>
                  <IconButton
                    aria-label={`Archive ${ENTITY_LABELS[editorEntity].slice(0, -1).toLowerCase()}`}
                    color="error"
                    onClick={() => openLifecycleDialog('archive', editorRecord)}
                  >
                    <ArchiveRounded />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
          )}
          {editorEntity === 'organizations' && <>
            <TextField disabled={!recordEditable} label="Organization" value={fields.name || ''} onChange={(event) => setFields({ ...fields, name: event.target.value })} required />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth select disabled={!recordEditable} label="Priority" value={fields.priority || ''} onChange={(event) => setFields({ ...fields, priority: event.target.value })}>
                <MenuItem value="">Unspecified</MenuItem>
                {!priorityOptions.includes(fields.priority || '') && fields.priority ? <MenuItem value={fields.priority}>{fields.priority}</MenuItem> : null}
                {priorityOptions.map((priority) => <MenuItem key={priority} value={priority}>{priority}</MenuItem>)}
              </TextField>
              <TextField fullWidth select disabled={!recordEditable} label="Type" value={fields.accountType || ''} onChange={(event) => setFields({ ...fields, accountType: event.target.value })}>
                <MenuItem value="">Unspecified</MenuItem>
                {!organizationTypeOptions.includes(fields.accountType || '') && fields.accountType ? <MenuItem value={fields.accountType}>{fields.accountType}</MenuItem> : null}
                {organizationTypeOptions.map((accountType) => <MenuItem key={accountType} value={accountType}>{accountType}</MenuItem>)}
              </TextField>
            </Stack>
            <TextField
              disabled={!recordEditable}
              select
              label="Owner"
              value={organizationOwnerSelection}
              onChange={(event) => {
                const referenceCode = event.target.value
                if (referenceCode === LEGACY_ORGANIZATION_OWNER) return
                const selected = pipelineUsers.find((user) => user.referenceCode === referenceCode)
                setFields({ ...fields, accountManager: selected?.displayName || '' })
              }}
            >
              <MenuItem value="">Unassigned</MenuItem>
              {organizationOwnerSelection === LEGACY_ORGANIZATION_OWNER ? (
                <MenuItem value={LEGACY_ORGANIZATION_OWNER}>{fields.accountManager} (legacy)</MenuItem>
              ) : null}
              {pipelineUsers.map((user) => (
                <MenuItem key={user.referenceCode} value={user.referenceCode}>
                  {user.displayName} ({user.email})
                </MenuItem>
              ))}
            </TextField>
            <TextField disabled={!recordEditable} label="Website" type="url" value={fields.website || ''} onChange={(event) => setFields({ ...fields, website: event.target.value })} />
            <TextField disabled={!recordEditable} label="LinkedIn URL" type="url" value={fields.linkedinUrl || ''} onChange={(event) => setFields({ ...fields, linkedinUrl: event.target.value })} />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="Phone" type="tel" value={fields.phone || ''} onChange={(event) => setFields({ ...fields, phone: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable} label="Email" type="email" value={fields.email || ''} onChange={(event) => setFields({ ...fields, email: event.target.value })} />
            </Stack>
            <FormControlLabel
              control={<Checkbox disabled={!recordEditable} checked={fields.emailOptOut === 'true'} onChange={(event) => setFields({ ...fields, emailOptOut: String(event.target.checked) })} />}
              label="Do not email"
            />
            <TextField disabled={!recordEditable} label="Address" value={fields.address || ''} onChange={(event) => setFields({ ...fields, address: event.target.value })} />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="City" value={fields.city || ''} onChange={(event) => setFields({ ...fields, city: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable} label="State" value={fields.state || ''} onChange={(event) => setFields({ ...fields, state: event.target.value })} />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="Postal code" value={fields.postalCode || ''} onChange={(event) => setFields({ ...fields, postalCode: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable} label="Country" value={fields.country || ''} onChange={(event) => setFields({ ...fields, country: event.target.value })} />
            </Stack>
          </>}
          {editorEntity === 'contacts' && <>
            <TextField disabled={!recordEditable} label="Contact Full Name" value={fields.fullName || ''} onChange={(event) => setFields({ ...fields, fullName: event.target.value })} required />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="First name" value={fields.firstName || ''} onChange={(event) => setFields({ ...fields, firstName: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable} label="Last name" value={fields.lastName || ''} onChange={(event) => setFields({ ...fields, lastName: event.target.value })} />
            </Stack>
            <TextField disabled={!recordEditable} select required label="Organization" value={fields.organizationId || ''} onChange={(event) => {
              const organizationId = event.target.value
              const selectedOrganization = organizations.find((record) => textValue(record, 'id') === organizationId)
              setFields({
                ...fields,
                organizationId,
                ...(useOrganizationAddress && selectedOrganization ? addressFields(selectedOrganization) : {}),
              })
            }}>
              {fields.organizationId && !organizations.some((record) => textValue(record, 'id') === fields.organizationId) ? (
                <MenuItem value={fields.organizationId}>{(editorRecord ? textValue(editorRecord, 'organizationName') : '') || 'Current organization'}</MenuItem>
              ) : null}
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            {editorRecord && fields.organizationId && (
              <Box component="section" aria-label="Related organization" sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2" fontWeight={700}>Related organization</Typography>
                <Divider sx={{ mt: 1 }} />
                <ListItemButton
                  aria-label={`Open organization ${relatedOrganization ? textValue(relatedOrganization, 'name') : textValue(editorRecord, 'organizationName')}`}
                  disabled={!relatedOrganization}
                  onClick={() => { if (relatedOrganization) openRelatedOrganization(relatedOrganization) }}
                  sx={{ px: 0, py: 1.25, minWidth: 0 }}
                >
                  <BusinessRounded color="primary" sx={{ mr: 1.25, flexShrink: 0 }} />
                  <ListItemText
                    primary={relatedOrganization ? textValue(relatedOrganization, 'name') : textValue(editorRecord, 'organizationName') || 'Current organization'}
                    secondary={relatedOrganization ? textValue(relatedOrganization, 'referenceCode') || 'Organization' : 'Organization record loading'}
                    primaryTypographyProps={{ fontWeight: 600, sx: { overflowWrap: 'anywhere' } }}
                    secondaryTypographyProps={{ sx: { mt: 0.25, overflowWrap: 'anywhere' } }}
                    sx={{ minWidth: 0, my: 0 }}
                  />
                  {relatedOrganization ? <ChevronRightRounded color="action" sx={{ ml: 1, flexShrink: 0 }} /> : <CircularProgress size={18} sx={{ ml: 1, flexShrink: 0 }} />}
                </ListItemButton>
              </Box>
            )}
            <TextField fullWidth select disabled={!recordEditable} label="Priority" value={fields.priority || ''} onChange={(event) => setFields({ ...fields, priority: event.target.value })}>
              {!priorityOptions.includes(fields.priority || '') && fields.priority ? <MenuItem value={fields.priority}>{fields.priority}</MenuItem> : null}
              {priorityOptions.map((priority) => <MenuItem key={priority} value={priority}>{priority}</MenuItem>)}
            </TextField>
            <TextField
              disabled={!recordEditable}
              select
              label="Owner"
              value={contactOwnerSelection}
              onChange={(event) => {
                const referenceCode = event.target.value
                if (referenceCode === LEGACY_CONTACT_OWNER) return
                const selected = pipelineUsers.find((user) => user.referenceCode === referenceCode)
                setFields({
                  ...fields,
                  ownerUserReferenceCode: referenceCode,
                  ownerEmail: selected?.email || '',
                  ownerDisplayName: selected?.displayName || '',
                  accountManager: selected?.displayName || '',
                })
              }}
            >
              <MenuItem value="">Unassigned</MenuItem>
              {!fields.ownerUserReferenceCode && fields.accountManager ? (
                <MenuItem value={LEGACY_CONTACT_OWNER}>{fields.accountManager} (legacy)</MenuItem>
              ) : null}
              {fields.ownerUserReferenceCode && !pipelineUsers.some((user) => user.referenceCode === fields.ownerUserReferenceCode) ? (
                <MenuItem value={fields.ownerUserReferenceCode}>
                  {fields.ownerDisplayName || fields.accountManager || fields.ownerEmail || fields.ownerUserReferenceCode}
                </MenuItem>
              ) : null}
              {pipelineUsers.map((user) => (
                <MenuItem key={user.referenceCode} value={user.referenceCode}>
                  {user.displayName} ({user.email})
                </MenuItem>
              ))}
            </TextField>
            <TextField disabled={!recordEditable} label="Title" value={fields.jobTitle || ''} onChange={(event) => setFields({ ...fields, jobTitle: event.target.value })} />
            <TextField disabled={!recordEditable} label="Email" type="email" value={fields.email || ''} onChange={(event) => setFields({ ...fields, email: event.target.value })} />
            <TextField disabled={!recordEditable} label="LinkedIn URL" type="url" value={fields.linkedinUrl || ''} onChange={(event) => setFields({ ...fields, linkedinUrl: event.target.value })} />
            <FormControlLabel
              control={<Checkbox disabled={!recordEditable} checked={fields.emailOptOut === 'true'} onChange={(event) => setFields({ ...fields, emailOptOut: String(event.target.checked) })} />}
              label="Do not email"
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="Work phone" type="tel" value={fields.phoneWork || ''} onChange={(event) => setFields({ ...fields, phoneWork: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable} label="Mobile" type="tel" value={fields.phoneMobile || ''} onChange={(event) => setFields({ ...fields, phoneMobile: event.target.value })} />
            </Stack>
            <FormControlLabel
              control={<Switch
                disabled={!recordEditable || !relatedOrganization}
                checked={useOrganizationAddress}
                onChange={(event) => {
                  const checked = event.target.checked
                  setUseOrganizationAddress(checked)
                  if (checked && relatedOrganization) setFields({ ...fields, ...addressFields(relatedOrganization) })
                }}
              />}
              label="Use organization address"
            />
            <TextField disabled={!recordEditable || useOrganizationAddress} label="Address" value={fields.address || ''} onChange={(event) => setFields({ ...fields, address: event.target.value })} />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable || useOrganizationAddress} label="City" value={fields.city || ''} onChange={(event) => setFields({ ...fields, city: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable || useOrganizationAddress} label="State" value={fields.state || ''} onChange={(event) => setFields({ ...fields, state: event.target.value })} />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable || useOrganizationAddress} label="Postal code" value={fields.postalCode || ''} onChange={(event) => setFields({ ...fields, postalCode: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable || useOrganizationAddress} label="Country" value={fields.country || ''} onChange={(event) => setFields({ ...fields, country: event.target.value })} />
            </Stack>
          </>}
          {editorEntity === 'leads' && <>
            <TextField disabled={!recordEditable} label="Lead" value={fields.fullName || ''} onChange={(event) => setFields({ ...fields, fullName: event.target.value })} required />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="First name" value={fields.firstName || ''} onChange={(event) => setFields({ ...fields, firstName: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable} label="Last name" value={fields.lastName || ''} onChange={(event) => setFields({ ...fields, lastName: event.target.value })} />
            </Stack>
            <TextField disabled={!recordEditable} select label="Organization" value={fields.organizationId || ''} onChange={(event) => setFields({ ...fields, organizationId: event.target.value })}>
              <MenuItem value="">Unlinked</MenuItem>
              {fields.organizationId && !organizations.some((record) => textValue(record, 'id') === fields.organizationId) ? (
                <MenuItem value={fields.organizationId}>{(editorRecord ? textValue(editorRecord, 'organizationName') : '') || 'Current organization'}</MenuItem>
              ) : null}
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} label="Company" value={fields.companyName || ''} onChange={(event) => setFields({ ...fields, companyName: event.target.value })} />
            <TextField disabled={!recordEditable} label="Title" value={fields.jobTitle || ''} onChange={(event) => setFields({ ...fields, jobTitle: event.target.value })} />
            <TextField disabled={!recordEditable} label="Email" type="email" value={fields.email || ''} onChange={(event) => setFields({ ...fields, email: event.target.value })} />
            <FormControlLabel
              control={<Checkbox disabled={!recordEditable} checked={fields.emailOptOut === 'true'} onChange={(event) => setFields({ ...fields, emailOptOut: String(event.target.checked) })} />}
              label="Do not email"
            />
            <TextField disabled={!recordEditable} label="Work phone" value={fields.phoneWork || ''} onChange={(event) => setFields({ ...fields, phoneWork: event.target.value })} />
            <TextField disabled={!recordEditable} label="Mobile" value={fields.phoneMobile || ''} onChange={(event) => setFields({ ...fields, phoneMobile: event.target.value })} />
            <TextField disabled={!recordEditable} label="Status" value={fields.status || ''} onChange={(event) => setFields({ ...fields, status: event.target.value })} />
            <TextField disabled={!recordEditable} label="Source" value={fields.source || ''} onChange={(event) => setFields({ ...fields, source: event.target.value })} />
            <TextField disabled={!recordEditable} select label="Owner" value={fields.assignedTo || ''} onChange={(event) => setFields({ ...fields, assignedTo: event.target.value })}>
              <MenuItem value="">Unassigned</MenuItem>
              {fields.assignedTo && !pipelineUsers.some((user) => (
                user.email === fields.assignedTo || user.displayName === fields.assignedTo
              )) ? <MenuItem value={fields.assignedTo}>{fields.assignedTo} (legacy)</MenuItem> : null}
              {pipelineUsers.map((user) => (
                <MenuItem key={user.email} value={user.email}>{user.displayName} ({user.email})</MenuItem>
              ))}
            </TextField>
          </>}
          {editorEntity === 'opportunities' && <>
            <TextField disabled label="Opportunity" value={fields.name || ''} />
            <TextField disabled label="Stage" value={fields.stage || ''} />
            <TextField disabled label="Status" value={fields.status || ''} />
            <TextField disabled label="Value" value={fields.value || ''} />
            <TextField disabled label="Probability" value={fields.probability || ''} />
            <TextField disabled label="Expected close" value={fields.expectedClose || ''} />
          </>}
          {editorEntity === 'products' && <>
            <Stack direction="row" gap={1} alignItems="center">
              <Inventory2Rounded color="primary" />
              <Typography variant="subtitle2" fontWeight={700}>Product catalog record</Typography>
            </Stack>
            {editorRecord ? (
              <Stack spacing={1}>
                <Typography variant="subtitle2" fontWeight={700}>
                  Sales channel presence
                </Typography>
                <Alert severity="info">
                  Provider lifecycle is read-only and separate from this
                  product&apos;s ClawPilot availability. “Source active” does
                  not by itself prove storefront publication.
                </Alert>
                {productSalesChannels(editorRecord).map((channel) => (
                  <Box
                    key={channel.id}
                    sx={{
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                      p: 1.25,
                    }}
                  >
                    <Stack
                      direction="row"
                      gap={0.75}
                      flexWrap="wrap"
                      alignItems="center"
                    >
                      <Chip
                        size="small"
                        label={providerLabel(channel.provider)}
                      />
                      <Chip
                        size="small"
                        variant="outlined"
                        color={salesChannelStatusColor(
                          channel.normalizedStatus,
                        )}
                        label={salesChannelStatusLabel(
                          channel.normalizedStatus,
                        )}
                      />
                      {channel.integrationAccountStatus !== 'active' ? (
                        <Chip
                          size="small"
                          variant="outlined"
                          color="warning"
                          label={`Connection ${channel.integrationAccountStatus}`}
                        />
                      ) : null}
                    </Stack>
                    <Typography variant="body2" sx={{ mt: 0.75 }}>
                      {channel.integrationAccountName} · {channel.environment}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                    >
                      Provider status: {channel.providerStatusRaw} · Variant: {channel.externalVariantId}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                    >
                      Last observed: {formatUserDateTime(
                        channel.observedAt,
                        dateTimeSettings,
                        {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          fallback: 'Unknown',
                        },
                      )}
                    </Typography>
                  </Box>
                ))}
                {productSalesChannels(editorRecord).length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No sales-channel variant is mapped to this product.
                  </Typography>
                ) : null}
              </Stack>
            ) : null}
            <TextField disabled={!recordEditable} label="Product name" value={fields.name || ''} onChange={(event) => setFields({ ...fields, name: event.target.value })} required />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="SKU" value={fields.sku || ''} inputProps={{ maxLength: 25 }} onChange={(event) => setFields({ ...fields, sku: event.target.value.slice(0, 25) })} helperText="Up to 25 characters" />
              <TextField fullWidth disabled={!recordEditable} label="Type" value={fields.productType || ''} onChange={(event) => setFields({ ...fields, productType: event.target.value })} />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="Category" value={fields.category || ''} onChange={(event) => setFields({ ...fields, category: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable} label="Status" value={fields.status || ''} onChange={(event) => setFields({ ...fields, status: event.target.value })} />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="Price" type="number" inputProps={{ min: 0, step: '0.01' }} value={fields.price || ''} onChange={(event) => setFields({ ...fields, price: event.target.value })} />
              <TextField fullWidth disabled={!recordEditable} label="Cost" type="number" inputProps={{ min: 0, step: '0.01' }} value={fields.cost || ''} onChange={(event) => setFields({ ...fields, cost: event.target.value })} />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ minWidth: 0 }}>
              <TextField fullWidth disabled={!recordEditable} label="Currency" value={fields.currency || ''} onChange={(event) => setFields({ ...fields, currency: event.target.value.toUpperCase().slice(0, 3) })} />
              <TextField fullWidth disabled={!recordEditable} select label="Availability" value={fields.active || 'true'} onChange={(event) => setFields({ ...fields, active: event.target.value })}>
                <MenuItem value="true">Active</MenuItem>
                <MenuItem value="false">Inactive</MenuItem>
              </TextField>
            </Stack>
            <TextField disabled={!recordEditable} label="Product URL" type="url" value={fields.url || ''} onChange={(event) => setFields({ ...fields, url: event.target.value })} />
          </>}
          {editorEntity === 'meetings' && <>
            <TextField disabled={!recordEditable} label="Meeting" value={fields.subject || ''} onChange={(event) => setFields({ ...fields, subject: event.target.value })} required />
            <TextField disabled={!recordEditable} select label="Status" value={fields.status || 'planned'} onChange={(event) => setFields({ ...fields, status: event.target.value })}>
              <MenuItem value="planned">Planned</MenuItem>
              <MenuItem value="queued">Queued for calendar</MenuItem>
              <MenuItem value="scheduled">Scheduled</MenuItem>
              <MenuItem value="completed">Completed</MenuItem>
              <MenuItem value="cancelled">Cancelled</MenuItem>
              <MenuItem value="failed">Failed</MenuItem>
            </TextField>
            <TextField disabled={!recordEditable} select label="Organization" value={fields.organizationId || ''} onChange={(event) => {
              const organizationId = event.target.value
              const selectedContact = contacts.find((record) => textValue(record, 'id') === fields.contactId)
              const selectedOpportunity = opportunities.find((record) => textValue(record, 'id') === fields.opportunityId)
              setFields({
                ...fields,
                organizationId,
                contactId: selectedContact && textValue(selectedContact, 'organizationId') === organizationId ? fields.contactId : '',
                opportunityId: selectedOpportunity && textValue(selectedOpportunity, 'organizationId') === organizationId
                  ? fields.opportunityId
                  : '',
              })
            }}>
              <MenuItem value="">Unlinked</MenuItem>
              {fields.organizationId && !organizations.some((record) => textValue(record, 'id') === fields.organizationId) ? (
                <MenuItem value={fields.organizationId}>{(editorRecord ? textValue(editorRecord, 'organizationName') : '') || 'Current organization'}</MenuItem>
              ) : null}
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} select label="Contact" value={fields.contactId || ''} onChange={(event) => setFields({ ...fields, contactId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {recordsForOrganization(contacts, fields.organizationId || '')
                .map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'fullName')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} select label="Lead" value={fields.leadId || ''} onChange={(event) => setFields({ ...fields, leadId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {leads.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'fullName')}</MenuItem>)}
            </TextField>
            <TextField
              disabled={!recordEditable}
              select
              label="Pipeline opportunity"
              value={fields.opportunityId || ''}
              onChange={(event) => setFields({ ...fields, opportunityId: event.target.value })}
              helperText="Choose the pipeline deal; its selected products appear in the list."
            >
              <MenuItem value="">None</MenuItem>
              {recordsForOrganization(opportunities, fields.organizationId || '')
                .map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{opportunityOptionLabel(record)}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} label="Starts" type="datetime-local" value={fields.startsAt || ''} onChange={(event) => setFields({ ...fields, startsAt: event.target.value })} InputLabelProps={{ shrink: true }} required />
            <TextField disabled={!recordEditable} label="Ends" type="datetime-local" value={fields.endsAt || ''} onChange={(event) => setFields({ ...fields, endsAt: event.target.value })} InputLabelProps={{ shrink: true }} required />
            <TextField disabled={!recordEditable} label="Timezone" value={fields.timezone || ''} onChange={(event) => setFields({ ...fields, timezone: event.target.value })} />
            <TextField disabled={!recordEditable} label="Location" value={fields.location || ''} onChange={(event) => setFields({ ...fields, location: event.target.value })} />
            <TextField disabled={!recordEditable} label="Attendee emails" value={fields.attendeeEmails || ''} onChange={(event) => setFields({ ...fields, attendeeEmails: event.target.value })} helperText="Separate addresses with commas" />
          </>}
          {editorEntity === 'interactions' && <>
            <TextField disabled={!recordEditable} label="Subject" value={fields.subject || ''} onChange={(event) => setFields({ ...fields, subject: event.target.value })} required />
            <TextField disabled={!recordEditable} select label="Organization" value={fields.organizationId || ''} onChange={(event) => {
              const organizationId = event.target.value
              const selectedContactIds = idList(fields.contactIds).filter((contactId) => {
                const selectedContact = contacts.find((record) => textValue(record, 'id') === contactId)
                return selectedContact && textValue(selectedContact, 'organizationId') === organizationId
              })
              const selectedOpportunity = opportunities.find((record) => textValue(record, 'id') === fields.opportunityId)
              setFields({
                ...fields,
                organizationId,
                contactId: selectedContactIds[0] || '',
                contactIds: selectedContactIds.join(','),
                opportunityId: selectedOpportunity && textValue(selectedOpportunity, 'organizationId') === organizationId
                  ? fields.opportunityId
                  : '',
              })
            }}>
              <MenuItem value="">None</MenuItem>
              {fields.organizationId && !organizations.some((record) => textValue(record, 'id') === fields.organizationId) ? (
                <MenuItem value={fields.organizationId}>{(editorRecord ? textValue(editorRecord, 'organizationName') : '') || 'Current organization'}</MenuItem>
              ) : null}
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <Autocomplete
              disabled={!recordEditable}
              multiple
              disableCloseOnSelect
              options={recordsForOrganization(contacts, fields.organizationId || '')}
              value={contacts.filter((record) => idList(fields.contactIds).includes(textValue(record, 'id')))}
              getOptionLabel={(record) => textValue(record, 'fullName') || textValue(record, 'referenceCode')}
              isOptionEqualToValue={(option, value) => textValue(option, 'id') === textValue(value, 'id')}
              onChange={(_, selectedContacts) => {
                const contactIds = selectedContacts.map((record) => textValue(record, 'id')).filter(Boolean)
                setFields({ ...fields, contactId: contactIds[0] || '', contactIds: contactIds.join(',') })
              }}
              renderOption={(props, record) => (
                <Box component="li" {...props} key={textValue(record, 'id')}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2">{textValue(record, 'fullName')}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {[textValue(record, 'jobTitle'), textValue(record, 'email'), textValue(record, 'referenceCode')].filter(Boolean).join(' · ')}
                    </Typography>
                  </Box>
                </Box>
              )}
              renderInput={(params) => (
                <TextField {...params} label="Contacts" placeholder="Select contacts" helperText="The first contact is the primary CRM relationship." />
              )}
            />
            <TextField disabled={!recordEditable} select label="Lead" value={fields.leadId || ''} onChange={(event) => setFields({ ...fields, leadId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {leads.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'fullName')}</MenuItem>)}
            </TextField>
            <TextField
              disabled={!recordEditable}
              select
              label="Pipeline opportunity"
              value={fields.opportunityId || ''}
              onChange={(event) => setFields({ ...fields, opportunityId: event.target.value })}
              helperText="Choose the pipeline deal; its selected products appear in the list."
            >
              <MenuItem value="">None</MenuItem>
              {recordsForOrganization(opportunities, fields.organizationId || '')
                .map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{opportunityOptionLabel(record)}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} select label="Campaign" value={fields.campaignId || ''} onChange={(event) => setFields({ ...fields, campaignId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {campaigns.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} select required label="Type" value={fields.interactionType || ''} onChange={(event) => {
              const interactionType = event.target.value
              const nativeActivity = interactionType === 'call' || interactionType === 'meeting'
              setFields({
                ...fields,
                interactionType,
                activityStatus: nativeActivity ? fields.activityStatus || 'held' : '',
                durationMinutes: nativeActivity
                  ? fields.interactionType === interactionType
                    ? fields.durationMinutes || (interactionType === 'call' ? '15' : '30')
                    : interactionType === 'call' ? '15' : '30'
                  : '',
                direction: interactionType === 'call'
                  ? fields.direction === 'inbound' ? 'inbound' : 'outbound'
                  : fields.direction,
              })
            }}>
              {fields.interactionType && !INTERACTION_TYPES.some((option) => option.value === fields.interactionType) ? (
                <MenuItem value={fields.interactionType}>{fields.interactionType} (legacy)</MenuItem>
              ) : null}
              {INTERACTION_TYPES.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
            </TextField>
            {(fields.interactionType === 'call' || (fields.interactionType === 'meeting' && !fields.meetingId)) && (
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField
                  fullWidth
                  disabled={!recordEditable}
                  select
                  label="Activity status"
                  value={fields.activityStatus || 'held'}
                  onChange={(event) => setFields({ ...fields, activityStatus: event.target.value })}
                  helperText={fields.activityStatus === 'planned'
                    ? 'Planned activities appear in SuiteCRM Activities.'
                    : 'Held and not-held activities appear in SuiteCRM History.'}
                >
                  {ACTIVITY_STATUSES.map((status) => <MenuItem key={status.value} value={status.value}>{status.label}</MenuItem>)}
                </TextField>
                <TextField
                  fullWidth
                  disabled={!recordEditable}
                  label="Duration (minutes)"
                  type="number"
                  inputProps={{ min: 1, max: 1440, step: 1 }}
                  value={fields.durationMinutes || (fields.interactionType === 'call' ? '15' : '30')}
                  onChange={(event) => setFields({ ...fields, durationMinutes: event.target.value })}
                />
              </Stack>
            )}
            {fields.interactionType === 'call' && (
              <TextField disabled={!recordEditable} select label="Direction" value={fields.direction || 'outbound'} onChange={(event) => setFields({ ...fields, direction: event.target.value })}>
                <MenuItem value="outbound">Outbound</MenuItem>
                <MenuItem value="inbound">Inbound</MenuItem>
              </TextField>
            )}
            {fields.interactionType === 'meeting' && fields.meetingId && (
              <Alert severity="info">
                This history entry is linked to a canonical meeting. Its native SuiteCRM activity comes from the meeting record.
              </Alert>
            )}
            <TextField disabled={!recordEditable} label="Date" type="datetime-local" value={fields.occurredAt || ''} onChange={(event) => setFields({ ...fields, occurredAt: event.target.value })} InputLabelProps={{ shrink: true }} />
            <TextField
              disabled={!recordEditable}
              select
              label="Agent"
              value={interactionAgentEmail}
              onChange={(event) => {
                const selected = pipelineUsers.find((user) => user.email === event.target.value)
                setFields({ ...fields, agentEmail: selected?.email || '', agentName: selected?.displayName || '' })
              }}
              helperText={fields.agentName && !interactionAgentEmail ? `Unmapped legacy agent: ${fields.agentName}` : 'Active ClawPilot users with access to this pipeline'}
            >
              <MenuItem value="">Unassigned</MenuItem>
              {pipelineUsers.map((user) => (
                <MenuItem key={user.email} value={user.email}>
                  {user.displayName} ({user.email}){user.suiteCrmMapped ? '' : ' - CRM mapping pending'}
                </MenuItem>
              ))}
            </TextField>
          </>}
          {editorEntity === 'campaigns' && <>
            <TextField disabled={!recordEditable} label="Campaign" value={fields.name || ''} onChange={(event) => setFields({ ...fields, name: event.target.value })} required />
            <TextField disabled={!recordEditable} select label="Status" value={fields.status || 'draft'} onChange={(event) => setFields({ ...fields, status: event.target.value })}>
              {['draft', 'queued', 'sending', 'sent', 'paused', 'failed'].map((status) => <MenuItem key={status} value={status}>{status}</MenuItem>)}
            </TextField>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
              <TextField disabled={!recordEditable} fullWidth label="Start date" type="date" value={fields.startDate || ''} onChange={(event) => setFields({ ...fields, startDate: event.target.value })} InputLabelProps={{ shrink: true }} />
              <TextField disabled={!recordEditable} fullWidth label="End date" type="date" value={fields.endDate || ''} onChange={(event) => setFields({ ...fields, endDate: event.target.value })} InputLabelProps={{ shrink: true }} />
            </Stack>
            <TextField disabled={!recordEditable} label="Sender email" type="email" value={fields.senderEmail || ''} onChange={(event) => setFields({ ...fields, senderEmail: event.target.value })} />
            <TextField disabled={!recordEditable} label="Subject template" value={fields.subjectTemplate || ''} onChange={(event) => setFields({ ...fields, subjectTemplate: event.target.value })} />
            <TextField disabled={!recordEditable} label="Message template" value={fields.bodyTemplate || ''} onChange={(event) => setFields({ ...fields, bodyTemplate: event.target.value })} multiline minRows={8} />
          </>}
          <TextField disabled={!recordEditable} label="Description" value={fields.description || fields.notes || ''} onChange={(event) => setFields({ ...fields, description: event.target.value, notes: event.target.value })} multiline minRows={4} />
          {editorEntity === 'leads' && editorRecord && convertedLead && (
            <Box component="section" aria-label="Converted records" sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" fontWeight={700}>Converted records</Typography>
              <Divider sx={{ mt: 1 }} />
              <List disablePadding>
                <ListItemButton
                  disabled={!convertedOrganization}
                  onClick={() => { if (convertedOrganization) openRelatedOrganization(convertedOrganization) }}
                  sx={{ px: 0, py: 1.25, minWidth: 0 }}
                >
                  <ListItemText
                    primary={textValue(editorRecord, 'organizationName') || 'Account'}
                    secondary={textValue(editorRecord, 'organizationReferenceCode') || 'Account'}
                    primaryTypographyProps={{ fontWeight: 600, sx: { overflowWrap: 'anywhere' } }}
                    sx={{ minWidth: 0 }}
                  />
                  {convertedOrganization ? <ChevronRightRounded color="action" /> : null}
                </ListItemButton>
                <ListItemButton
                  disabled={!convertedContact}
                  onClick={() => { if (convertedContact) openRelatedContact(convertedContact) }}
                  sx={{ px: 0, py: 1.25, minWidth: 0 }}
                >
                  <ListItemText
                    primary={textValue(editorRecord, 'convertedContactName') || 'Contact'}
                    secondary={textValue(editorRecord, 'convertedContactReferenceCode') || 'Contact'}
                    primaryTypographyProps={{ fontWeight: 600, sx: { overflowWrap: 'anywhere' } }}
                    sx={{ minWidth: 0 }}
                  />
                  {convertedContact ? <ChevronRightRounded color="action" /> : null}
                </ListItemButton>
                <ListItemButton
                  disabled={!convertedOpportunity}
                  onClick={() => { if (convertedOpportunity) openRelatedOpportunity(convertedOpportunity) }}
                  sx={{ px: 0, py: 1.25, minWidth: 0 }}
                >
                  <ListItemText
                    primary={textValue(editorRecord, 'convertedOpportunityName') || 'Opportunity'}
                    secondary={textValue(editorRecord, 'convertedOpportunityReferenceCode') || 'Opportunity'}
                    primaryTypographyProps={{ fontWeight: 600, sx: { overflowWrap: 'anywhere' } }}
                    sx={{ minWidth: 0 }}
                  />
                  {convertedOpportunity ? <ChevronRightRounded color="action" /> : null}
                </ListItemButton>
              </List>
            </Box>
          )}
          {editorEntity === 'campaigns' && editorRecord && (
            <Box component="section" aria-label="Campaign recipients" sx={{ minWidth: 0 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Typography variant="subtitle2" fontWeight={700}>Recipients</Typography>
                {!relatedActivityLoading && <Typography variant="caption" color="text.secondary">{campaignRecipients.length}</Typography>}
              </Stack>
              <Divider sx={{ mt: 1 }} />
              {relatedActivityLoading ? (
                <Box sx={{ py: 2.5, display: 'grid', placeItems: 'center' }}><CircularProgress size={22} /></Box>
              ) : campaignRecipients.length > 0 ? (
                <List disablePadding>
                  {campaignRecipients.map((recipient, index) => (
                    <ListItemButton key={recipient.id} disabled divider={index < campaignRecipients.length - 1} sx={{ px: 0, py: 1.25, minWidth: 0 }}>
                      <ListItemText
                        primary={recipient.name || recipient.email}
                        secondary={[recipient.referenceCode, recipient.email, recipient.status].filter(Boolean).join(' · ')}
                        primaryTypographyProps={{ fontWeight: 600, sx: { overflowWrap: 'anywhere' } }}
                        secondaryTypographyProps={{ sx: { whiteSpace: 'normal', overflowWrap: 'anywhere' } }}
                        sx={{ minWidth: 0 }}
                      />
                      <Chip size="small" label={recipient.status} variant="outlined" color={recipient.status === 'failed' ? 'error' : recipient.status === 'sent' ? 'success' : recipient.status === 'suppressed' ? 'warning' : 'default'} />
                    </ListItemButton>
                  ))}
                </List>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>No campaign recipients</Typography>
              )}
            </Box>
          )}
          {(editorEntity === 'leads' || editorEntity === 'campaigns') && editorRecord && (
            <Box component="section" aria-label="Related CRM activity" sx={{ minWidth: 0 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Typography variant="subtitle2" fontWeight={700}>Activity</Typography>
                {!relatedActivityLoading && <Typography variant="caption" color="text.secondary">{relatedActivity.length}</Typography>}
              </Stack>
              <Divider sx={{ mt: 1 }} />
              {relatedActivityLoading ? (
                <Box sx={{ py: 2.5, display: 'grid', placeItems: 'center' }}><CircularProgress size={22} /></Box>
              ) : relatedActivity.length > 0 ? (
                <List disablePadding>
                  {relatedActivity.map((activity, index) => (
                    <ListItemButton
                      key={textValue(activity, 'id')}
                      divider={index < relatedActivity.length - 1}
                      onClick={() => openRelatedInteraction(activity)}
                      sx={{ px: 0, py: 1.25, alignItems: 'flex-start', minWidth: 0 }}
                    >
                      <ListItemText
                        primary={textValue(activity, 'subject') || textValue(activity, 'referenceCode')}
                        secondary={[
                          textValue(activity, 'interactionType'),
                          displayValue(activity, 'occurredAt', dateTimeSettings),
                          textValue(activity, 'deliveryStatus'),
                          textValue(activity, 'referenceCode'),
                        ].filter((value) => value && value !== '—').join(' · ')}
                        primaryTypographyProps={{ fontWeight: 600, sx: { overflowWrap: 'anywhere' } }}
                        secondaryTypographyProps={{ sx: { whiteSpace: 'normal', overflowWrap: 'anywhere' } }}
                        sx={{ minWidth: 0 }}
                      />
                      <ChevronRightRounded color="action" sx={{ mt: 0.5, ml: 1, flexShrink: 0 }} />
                    </ListItemButton>
                  ))}
                </List>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>No related activity</Typography>
              )}
            </Box>
          )}
          {editorEntity === 'organizations' && editorRecord && (
            <Box component="section" sx={{ minWidth: 0 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Typography variant="subtitle2" fontWeight={700}>Contacts</Typography>
                {!relatedContactsLoading && (
                  <Typography variant="caption" color="text.secondary">{relatedContacts.length}</Typography>
                )}
              </Stack>
              <Divider sx={{ mt: 1 }} />
              {relatedContactsLoading ? (
                <Box sx={{ py: 2.5, display: 'grid', placeItems: 'center' }}>
                  <CircularProgress size={22} />
                </Box>
              ) : relatedContacts.length > 0 ? (
                <List disablePadding>
                  {relatedContacts.map((contact, index) => {
                    const name = textValue(contact, 'fullName')
                      || [textValue(contact, 'firstName'), textValue(contact, 'lastName')].filter(Boolean).join(' ')
                      || textValue(contact, 'referenceCode')
                    const detail = [
                      textValue(contact, 'jobTitle'),
                      textValue(contact, 'email'),
                      textValue(contact, 'phoneWork') || textValue(contact, 'phoneMobile'),
                      textValue(contact, 'referenceCode'),
                    ].filter(Boolean).join(' · ')
                    return (
                      <ListItemButton
                        key={textValue(contact, 'id')}
                        divider={index < relatedContacts.length - 1}
                        onClick={() => openRelatedContact(contact)}
                        sx={{ px: 0, py: 1.25, alignItems: 'flex-start', minWidth: 0 }}
                      >
                        <ListItemText
                          primary={name}
                          secondary={detail || 'Contact'}
                          primaryTypographyProps={{ fontWeight: 600, sx: { overflowWrap: 'anywhere' } }}
                          secondaryTypographyProps={{ sx: { mt: 0.25, whiteSpace: 'normal', overflowWrap: 'anywhere' } }}
                          sx={{ minWidth: 0, my: 0 }}
                        />
                        <ChevronRightRounded color="action" sx={{ mt: 0.5, ml: 1, flexShrink: 0 }} />
                      </ListItemButton>
                    )
                  })}
                </List>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  No related contacts
                </Typography>
              )}
            </Box>
          )}
          {(editorEntity === 'organizations' || editorEntity === 'contacts') && editorRecord && (
            <Box component="section" aria-label="Related opportunities" sx={{ minWidth: 0 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Typography variant="subtitle2" fontWeight={700}>Opportunities</Typography>
                <Typography variant="caption" color="text.secondary">{relatedOpportunities.length}</Typography>
              </Stack>
              <Divider sx={{ mt: 1 }} />
              {relatedOpportunities.length > 0 ? (
                <List disablePadding>
                  {relatedOpportunities.map((opportunity, index) => (
                    <ListItemButton
                      key={textValue(opportunity, 'id')}
                      divider={index < relatedOpportunities.length - 1}
                      onClick={() => openRelatedOpportunity(opportunity)}
                      sx={{ px: 0, py: 1.25, alignItems: 'flex-start', minWidth: 0 }}
                    >
                      <ListItemText
                        primary={textValue(opportunity, 'name') || textValue(opportunity, 'referenceCode')}
                        secondary={[
                          textValue(opportunity, 'stage'),
                          money(opportunity.value),
                          textValue(opportunity, 'referenceCode'),
                        ].filter(Boolean).join(' · ')}
                        primaryTypographyProps={{ fontWeight: 600, sx: { overflowWrap: 'anywhere' } }}
                        secondaryTypographyProps={{ sx: { mt: 0.25, whiteSpace: 'normal', overflowWrap: 'anywhere' } }}
                        sx={{ minWidth: 0, my: 0 }}
                      />
                      <ChevronRightRounded color="action" sx={{ mt: 0.5, ml: 1, flexShrink: 0 }} />
                    </ListItemButton>
                  ))}
                </List>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>No related opportunities</Typography>
              )}
            </Box>
          )}
          {recordEditable && <Button variant="contained" onClick={saveRecord} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}
        </Stack>
      </Drawer>
    </Box>
  )
}
