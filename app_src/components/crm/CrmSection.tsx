'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
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
  Link,
  MenuItem,
  Stack,
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
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import AccountTreeRounded from '@mui/icons-material/AccountTreeRounded'
import BusinessRounded from '@mui/icons-material/BusinessRounded'
import CampaignRounded from '@mui/icons-material/CampaignRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import EmailRounded from '@mui/icons-material/EmailRounded'
import EventRounded from '@mui/icons-material/EventRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import PhoneRounded from '@mui/icons-material/PhoneRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import UploadFileRounded from '@mui/icons-material/UploadFileRounded'
import WorkspaceSelector from '@/components/workspaces/WorkspaceSelector'
import type { CrmEntity, CrmSummary } from '@/lib/crm/types'

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
type PipelineInfo = {
  id: string
  name: string
  ownerEmail: string
  workspaceOrganizationId: string | null
  accessRole: 'owner' | 'editor' | 'viewer'
  shortLinkUrl: string | null
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
  canManageHierarchy?: boolean
  suiteCrmPunchoutUrl?: string | null
  suiteCrmUsername?: string | null
  suiteCrmAdminPortalUrl?: string | null
}

const ENTITY_LABELS: Record<CrmEntity, string> = {
  organizations: 'Organizations',
  contacts: 'Contacts',
  leads: 'Leads',
  opportunities: 'Opportunities',
  meetings: 'Meetings',
  interactions: 'Interactions',
  campaigns: 'Campaigns',
}

const EMPTY_SUMMARY: CrmSummary = {
  organizations: 0,
  contacts: 0,
  leads: 0,
  opportunities: 0,
  meetings: 0,
  interactions: 0,
  campaigns: 0,
  openPipelineValue: 0,
  weightedPipelineValue: 0,
  pendingSync: 0,
  failedSync: 0,
}

function textValue(record: RecordValue, key: string) {
  return String(record[key] ?? '')
}

function money(value: unknown) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    .format(Number(value) || 0)
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
  if (entity === 'meetings') return [
    ['referenceCode', 'ID'], ['subject', 'Meeting'], ['startsAt', 'Starts'], ['status', 'Status'], ['contactName', 'Contact'],
  ] as const
  if (entity === 'campaigns') return [
    ['referenceCode', 'ID'], ['name', 'Campaign'], ['status', 'Status'], ['recipientCount', 'Recipients'], ['sentCount', 'Sent'],
  ] as const
  return [
    ['referenceCode', 'ID'], ['subject', 'Interaction'], ['interactionType', 'Type'], ['occurredAt', 'Date'], ['agentName', 'Agent'],
  ] as const
}

function entityForReference(reference: string): CrmEntity | null {
  const prefix = reference.slice(0, 2).toLowerCase()
  return ({
    ga: 'organizations', gc: 'contacts', gl: 'leads', go: 'opportunities',
    gm: 'meetings', gi: 'interactions', gk: 'campaigns',
  } as Record<string, CrmEntity>)[prefix] || null
}

function initialFields(entity: CrmEntity, record: RecordValue | null): Record<string, string> {
  const source = record || {}
  if (entity === 'organizations') return {
    name: textValue(source, 'name'), accountType: textValue(source, 'accountType'),
    accountManager: textValue(source, 'accountManager'), website: textValue(source, 'website'),
    phone: textValue(source, 'phone'), description: textValue(source, 'description'),
  }
  if (entity === 'contacts') return {
    fullName: textValue(source, 'fullName'), organizationId: textValue(source, 'organizationId'),
    jobTitle: textValue(source, 'jobTitle'), email: textValue(source, 'email'),
    phoneWork: textValue(source, 'phoneWork'), phoneMobile: textValue(source, 'phoneMobile'),
    description: textValue(source, 'description'),
  }
  if (entity === 'leads') return {
    fullName: textValue(source, 'fullName'), organizationId: textValue(source, 'organizationId'),
    companyName: textValue(source, 'companyName'), jobTitle: textValue(source, 'jobTitle'),
    email: textValue(source, 'email'), phoneWork: textValue(source, 'phoneWork'),
    phoneMobile: textValue(source, 'phoneMobile'), status: textValue(source, 'status'),
    source: textValue(source, 'source'), assignedTo: textValue(source, 'assignedTo'),
    description: textValue(source, 'description'),
  }
  if (entity === 'opportunities') return {
    name: textValue(source, 'name'), organizationId: textValue(source, 'organizationId'),
    stage: textValue(source, 'stage'), status: textValue(source, 'status'), value: textValue(source, 'value'),
    probability: textValue(source, 'probability'), expectedClose: textValue(source, 'expectedClose'),
    notes: textValue(source, 'notes'),
  }
  if (entity === 'meetings') return {
    subject: textValue(source, 'subject'), organizationId: textValue(source, 'organizationId'),
    contactId: textValue(source, 'contactId'), leadId: textValue(source, 'leadId'),
    opportunityId: textValue(source, 'opportunityId'), startsAt: textValue(source, 'startsAt').slice(0, 16),
    endsAt: textValue(source, 'endsAt').slice(0, 16), timezone: textValue(source, 'timezone') || 'America/New_York',
    location: textValue(source, 'location'), attendeeEmails: Array.isArray(source.attendeeEmails)
      ? source.attendeeEmails.map(String).join(', ') : '', status: textValue(source, 'status') || 'planned',
    description: textValue(source, 'description'),
  }
  if (entity === 'campaigns') return {
    name: textValue(source, 'name'), status: textValue(source, 'status') || 'draft',
    startDate: textValue(source, 'startDate'), endDate: textValue(source, 'endDate'),
    subjectTemplate: textValue(source, 'subjectTemplate'), bodyTemplate: textValue(source, 'bodyTemplate'),
    senderEmail: textValue(source, 'senderEmail'), description: textValue(source, 'description'),
  }
  return {
    subject: textValue(source, 'subject'), organizationId: textValue(source, 'organizationId'),
    interactionType: textValue(source, 'interactionType'), occurredAt: textValue(source, 'occurredAt').slice(0, 16),
    agentName: textValue(source, 'agentName'), description: textValue(source, 'description'),
  }
}

export default function CrmSection() {
  const [entity, setEntity] = useState<CrmEntity>('organizations')
  const [records, setRecords] = useState<RecordValue[]>([])
  const [summary, setSummary] = useState<CrmSummary>(EMPTY_SUMMARY)
  const [pipeline, setPipeline] = useState<PipelineInfo | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editorRecord, setEditorRecord] = useState<RecordValue | null | undefined>(undefined)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [organizations, setOrganizations] = useState<RecordValue[]>([])
  const [contacts, setContacts] = useState<RecordValue[]>([])
  const [leads, setLeads] = useState<RecordValue[]>([])
  const [opportunities, setOpportunities] = useState<RecordValue[]>([])
  const [workspaceHierarchy, setWorkspaceHierarchy] = useState<WorkspaceOrganization[]>([])
  const [canManageHierarchy, setCanManageHierarchy] = useState(false)
  const [suiteCrmPunchoutUrl, setSuiteCrmPunchoutUrl] = useState<string | null>(null)
  const [suiteCrmUsername, setSuiteCrmUsername] = useState<string | null>(null)
  const [suiteCrmAdminPortalUrl, setSuiteCrmAdminPortalUrl] = useState<string | null>(null)
  const [suiteCrmAccessOpen, setSuiteCrmAccessOpen] = useState(false)
  const [hierarchyOpen, setHierarchyOpen] = useState(false)
  const [actionComposer, setActionComposer] = useState<{ type: CrmActionType; record: RecordValue } | null>(null)
  const [actionFields, setActionFields] = useState<Record<string, string>>({})
  const [routeQuery, setRouteQuery] = useState('')
  const deepLinkOpened = useRef(false)

  const load = useCallback(async (nextEntity: CrmEntity, nextQuery: string) => {
    setLoading(true)
    setError('')
    try {
      const parameters = new URLSearchParams({ entity: nextEntity, query: nextQuery, limit: '1000' })
      const response = await fetch(`/api/crm?${parameters}`)
      const payload = await response.json().catch(() => ({})) as CrmPayload
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to load CRM records')
      setRecords(payload.records || [])
      setSummary(payload.summary || EMPTY_SUMMARY)
      setPipeline(payload.pipeline || null)
      setWorkspaceHierarchy(payload.workspaceHierarchy || [])
      setCanManageHierarchy(payload.canManageHierarchy === true)
      setSuiteCrmPunchoutUrl(payload.suiteCrmPunchoutUrl || null)
      setSuiteCrmUsername(payload.suiteCrmUsername || null)
      setSuiteCrmAdminPortalUrl(payload.suiteCrmAdminPortalUrl || null)
      const reference = new URLSearchParams(window.location.search).get('crm')?.trim().toLowerCase() || ''
      const matched = reference && entityForReference(reference) === nextEntity
        ? (payload.records || []).find((record) => textValue(record, 'referenceCode') === reference)
        : null
      if (matched && !deepLinkOpened.current) {
        deepLinkOpened.current = true
        setEditorRecord(matched)
        setFields(initialFields(nextEntity, matched))
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load CRM records')
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const reference = new URLSearchParams(window.location.search).get('crm')?.trim().toLowerCase() || ''
    const linkedEntity = entityForReference(reference)
    if (linkedEntity) {
      setEntity(linkedEntity)
      setQuery(reference)
      setRouteQuery(reference)
    }
  }, [])

  useEffect(() => { void load(entity, routeQuery) }, [entity, load, routeQuery])

  const editable = Boolean(pipeline && pipeline.accessRole !== 'viewer' && entity !== 'opportunities')
  const recordEditable = editable && !editorRecord?.workspaceOrganizationId
  const tableColumns = useMemo(() => columns(entity), [entity])
  const actionReady = Boolean(actionComposer && (
    actionComposer.type === 'send_email'
      ? actionFields.subject?.trim() && actionFields.text?.trim()
      : actionComposer.type === 'log_call'
        ? actionFields.subject?.trim()
        : actionComposer.type === 'create_calendar_event'
          ? actionFields.subject?.trim() && actionFields.startsAt && actionFields.endsAt
          : actionFields.recipientReferences?.trim() && actionFields.subject?.trim() && actionFields.text?.trim()
  ))

  async function openEditor(record: RecordValue | null) {
    if (!record && !editable) return
    setEditorRecord(record)
    setFields(initialFields(entity, record))
    if (['contacts', 'leads', 'meetings', 'interactions'].includes(entity) && organizations.length === 0) {
      const response = await fetch('/api/crm?entity=organizations&limit=1000')
      const payload = await response.json().catch(() => ({})) as CrmPayload
      if (response.ok && payload.ok) setOrganizations(payload.records || [])
    }
    if (entity === 'meetings') {
      const [contactResponse, leadResponse, opportunityResponse] = await Promise.all([
        contacts.length === 0 ? fetch('/api/crm?entity=contacts&limit=1000') : null,
        leads.length === 0 ? fetch('/api/crm?entity=leads&limit=1000') : null,
        opportunities.length === 0 ? fetch('/api/crm?entity=opportunities&limit=1000') : null,
      ])
      if (contactResponse?.ok) setContacts(((await contactResponse.json()) as CrmPayload).records || [])
      if (leadResponse?.ok) setLeads(((await leadResponse.json()) as CrmPayload).records || [])
      if (opportunityResponse?.ok) setOpportunities(((await opportunityResponse.json()) as CrmPayload).records || [])
    }
  }

  async function saveRecord() {
    if (editorRecord === undefined) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/crm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity,
          id: editorRecord?.id,
          fields: entity === 'meetings'
            ? { ...fields, attendeeEmails: fields.attendeeEmails?.split(',').map((email) => email.trim()).filter(Boolean) || [] }
            : fields,
        }),
      })
      const payload = await response.json().catch(() => ({})) as CrmPayload
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to save CRM record')
      setEditorRecord(undefined)
      setNotice('Saved and queued for CRM sync')
      await load(entity, query)
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
      setActionFields({ subject: `Follow-up: ${recordName}`, text: '' })
    } else if (type === 'create_calendar_event') {
      setActionFields({
        subject: textValue(record, 'subject') || `Meeting with ${recordName}`,
        description: textValue(record, 'description'),
        startsAt: textValue(record, 'startsAt').slice(0, 16),
        endsAt: textValue(record, 'endsAt').slice(0, 16),
        timezone: textValue(record, 'timezone') || 'America/New_York',
        location: textValue(record, 'location'),
        attendeeEmails: Array.isArray(record.attendeeEmails)
          ? record.attendeeEmails.map(String).join(', ')
          : textValue(record, 'email'),
      })
    } else if (type === 'log_call') {
      setActionFields({ subject: `Call ${recordName}`, notes: '' })
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
          ? { subject: actionFields.subject, notes: actionFields.notes }
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
      if (entity === 'interactions' || entity === 'meetings' || entity === 'campaigns') await load(entity, query)
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
      await load(entity, query)
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
      await load(entity, query)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update organization hierarchy')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, pt: 2.5, pb: 1.5, flexShrink: 0 }}>
        <Stack direction={{ xs: 'column', lg: 'row' }} justifyContent="space-between" gap={1.5}>
          <Box>
            <Typography variant="h5" fontWeight={700}>CRM</Typography>
            <Typography variant="body2" color="text.secondary">{pipeline?.name || 'Customer records'}</Typography>
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ sm: 'center' }}>
            <WorkspaceSelector kind="pipeline" />
            {workspaceHierarchy.length > 0 && (
              <Button
                startIcon={<AccountTreeRounded />}
                variant="outlined"
                onClick={() => setHierarchyOpen(true)}
              >
                Hierarchy
              </Button>
            )}
            {pipeline?.shortLinkUrl && (
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
            )}
            {suiteCrmPunchoutUrl && (
              <Button
                startIcon={<OpenInNewRounded />}
                variant="outlined"
                onClick={() => setSuiteCrmAccessOpen(true)}
              >
                Open SuiteCRM
              </Button>
            )}
          </Stack>
        </Stack>
        <Stack direction="row" gap={1} mt={2} sx={{ overflowX: 'auto', pb: 0.5 }}>
          <Chip label={`${summary.organizations} organizations`} />
          <Chip label={`${summary.contacts} contacts`} />
          <Chip label={`${summary.leads} leads`} />
          <Chip label={`${summary.opportunities} opportunities`} />
          <Chip label={`${summary.meetings} meetings`} />
          <Chip label={`${summary.interactions} interactions`} />
          <Chip label={`${summary.campaigns} campaigns`} />
          <Chip label={money(summary.openPipelineValue)} color="primary" variant="outlined" />
          {summary.pendingSync > 0 && <Chip label={`${summary.pendingSync} syncing`} color="warning" />}
          {summary.failedSync > 0 && <Chip label={`${summary.failedSync} failed`} color="error" />}
        </Stack>
      </Box>
      <Divider />
      <Box sx={{ px: { xs: 2, md: 3 }, pt: 1.25, flexShrink: 0 }}>
        {error && <Alert severity="error" onClose={() => setError('')} sx={{ mb: 1 }}>{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 1 }}>{notice}</Alert>}
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1} alignItems={{ md: 'center' }}>
          <Tabs value={entity} onChange={(_, value: CrmEntity) => {
            deepLinkOpened.current = true
            setEntity(value)
            setQuery('')
            setRouteQuery('')
          }} variant="scrollable">
            {(Object.keys(ENTITY_LABELS) as CrmEntity[]).map((value) => (
              <Tab key={value} value={value} label={ENTITY_LABELS[value]} />
            ))}
          </Tabs>
          <Stack direction="row" gap={0.75} alignItems="center">
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
              <Button variant="contained" startIcon={<AddRounded />} onClick={() => openEditor(null)}>
                Add
              </Button>
            )}
          </Stack>
        </Stack>
        <TextField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void load(entity, query) }}
          placeholder={`Search ${ENTITY_LABELS[entity].toLowerCase()}`}
          size="small"
          fullWidth
          sx={{ mt: 1.25, mb: 1 }}
          InputProps={{
            startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment>,
            endAdornment: query ? <InputAdornment position="end"><IconButton size="small" aria-label="Run search" onClick={() => load(entity, query)}><SearchRounded fontSize="small" /></IconButton></InputAdornment> : undefined,
          }}
        />
      </Box>
      <TableContainer sx={{ flex: 1, minHeight: 0, px: { xs: 0, md: 3 } }}>
        {loading ? (
          <Box display="grid" sx={{ placeItems: 'center', height: 240 }}><CircularProgress size={28} /></Box>
        ) : (
          <Table stickyHeader size="small" sx={{ minWidth: 720 }}>
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
                      ) : entity === 'opportunities' && key === 'value' ? money(record[key]) : textValue(record, key) || '—'}
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

      <Dialog
        open={suiteCrmAccessOpen}
        onClose={() => setSuiteCrmAccessOpen(false)}
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
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
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
              <TextField label="Subject" required value={actionFields.subject || ''} onChange={(event) => setActionFields({ ...actionFields, subject: event.target.value })} />
              <TextField label="Message" required multiline minRows={8} value={actionFields.text || ''} onChange={(event) => setActionFields({ ...actionFields, text: event.target.value })} />
            </>}
            {actionComposer?.type === 'log_call' && <>
              <TextField label="Subject" required value={actionFields.subject || ''} onChange={(event) => setActionFields({ ...actionFields, subject: event.target.value })} />
              <TextField label="Call notes" multiline minRows={5} value={actionFields.notes || ''} onChange={(event) => setActionFields({ ...actionFields, notes: event.target.value })} />
            </>}
            {actionComposer?.type === 'create_calendar_event' && <>
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
        onClose={() => { if (!busy) setEditorRecord(undefined) }}
        PaperProps={{ sx: { width: { xs: '100%', sm: 460 }, maxWidth: '100vw' } }}
      >
        <Box sx={{ p: 2.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" fontWeight={700}>{editorRecord ? 'Edit' : 'Add'} {ENTITY_LABELS[entity].slice(0, -1)}</Typography>
          <IconButton aria-label="Close editor" onClick={() => setEditorRecord(undefined)} disabled={busy}><CloseRounded /></IconButton>
        </Box>
        <Divider />
        <Stack spacing={2} sx={{ p: 2.5, overflowY: 'auto' }}>
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
          {editorRecord && editable && (
            <Stack direction="row" gap={1} flexWrap="wrap">
              {(entity === 'contacts' || entity === 'leads') && Boolean(editorRecord.email) && (
                <Button startIcon={<EmailRounded />} variant="outlined" onClick={() => openAction('send_email', editorRecord)}>
                  Email
                </Button>
              )}
              {Boolean(editorRecord.phone || editorRecord.phoneWork || editorRecord.phoneMobile) && (
                <Button startIcon={<PhoneRounded />} variant="outlined" onClick={() => openAction('log_call', editorRecord)}>
                  Call
                </Button>
              )}
              {!['interactions', 'campaigns'].includes(entity) && (
                <Button startIcon={<EventRounded />} variant="outlined" onClick={() => openAction('create_calendar_event', editorRecord)}>
                  Schedule
                </Button>
              )}
              {entity === 'campaigns' && (
                <Button startIcon={<CampaignRounded />} variant="outlined" onClick={() => openAction('send_campaign', editorRecord)}>
                  Send campaign
                </Button>
              )}
            </Stack>
          )}
          {entity === 'organizations' && <>
            <TextField disabled={!recordEditable} label="Organization" value={fields.name || ''} onChange={(event) => setFields({ ...fields, name: event.target.value })} required />
            <TextField disabled={!recordEditable} label="Type" value={fields.accountType || ''} onChange={(event) => setFields({ ...fields, accountType: event.target.value })} />
            <TextField disabled={!recordEditable} label="Owner" value={fields.accountManager || ''} onChange={(event) => setFields({ ...fields, accountManager: event.target.value })} />
            <TextField disabled={!recordEditable} label="Website" value={fields.website || ''} onChange={(event) => setFields({ ...fields, website: event.target.value })} />
            <TextField disabled={!recordEditable} label="Phone" value={fields.phone || ''} onChange={(event) => setFields({ ...fields, phone: event.target.value })} />
          </>}
          {entity === 'contacts' && <>
            <TextField disabled={!recordEditable} label="Contact" value={fields.fullName || ''} onChange={(event) => setFields({ ...fields, fullName: event.target.value })} required />
            <TextField disabled={!recordEditable} select required label="Organization" value={fields.organizationId || ''} onChange={(event) => setFields({ ...fields, organizationId: event.target.value })}>
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} label="Title" value={fields.jobTitle || ''} onChange={(event) => setFields({ ...fields, jobTitle: event.target.value })} />
            <TextField disabled={!recordEditable} label="Email" type="email" value={fields.email || ''} onChange={(event) => setFields({ ...fields, email: event.target.value })} />
            <TextField disabled={!recordEditable} label="Work phone" value={fields.phoneWork || ''} onChange={(event) => setFields({ ...fields, phoneWork: event.target.value })} />
            <TextField disabled={!recordEditable} label="Mobile" value={fields.phoneMobile || ''} onChange={(event) => setFields({ ...fields, phoneMobile: event.target.value })} />
          </>}
          {entity === 'leads' && <>
            <TextField disabled={!recordEditable} label="Lead" value={fields.fullName || ''} onChange={(event) => setFields({ ...fields, fullName: event.target.value })} required />
            <TextField disabled={!recordEditable} select label="Organization" value={fields.organizationId || ''} onChange={(event) => setFields({ ...fields, organizationId: event.target.value })}>
              <MenuItem value="">Unlinked</MenuItem>
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} label="Company" value={fields.companyName || ''} onChange={(event) => setFields({ ...fields, companyName: event.target.value })} />
            <TextField disabled={!recordEditable} label="Title" value={fields.jobTitle || ''} onChange={(event) => setFields({ ...fields, jobTitle: event.target.value })} />
            <TextField disabled={!recordEditable} label="Email" type="email" value={fields.email || ''} onChange={(event) => setFields({ ...fields, email: event.target.value })} />
            <TextField disabled={!recordEditable} label="Work phone" value={fields.phoneWork || ''} onChange={(event) => setFields({ ...fields, phoneWork: event.target.value })} />
            <TextField disabled={!recordEditable} label="Mobile" value={fields.phoneMobile || ''} onChange={(event) => setFields({ ...fields, phoneMobile: event.target.value })} />
            <TextField disabled={!recordEditable} label="Status" value={fields.status || ''} onChange={(event) => setFields({ ...fields, status: event.target.value })} />
            <TextField disabled={!recordEditable} label="Source" value={fields.source || ''} onChange={(event) => setFields({ ...fields, source: event.target.value })} />
          </>}
          {entity === 'opportunities' && <>
            <TextField disabled label="Opportunity" value={fields.name || ''} />
            <TextField disabled label="Stage" value={fields.stage || ''} />
            <TextField disabled label="Status" value={fields.status || ''} />
            <TextField disabled label="Value" value={fields.value || ''} />
            <TextField disabled label="Probability" value={fields.probability || ''} />
            <TextField disabled label="Expected close" value={fields.expectedClose || ''} />
          </>}
          {entity === 'meetings' && <>
            <TextField disabled={!recordEditable} label="Meeting" value={fields.subject || ''} onChange={(event) => setFields({ ...fields, subject: event.target.value })} required />
            <TextField disabled={!recordEditable} select label="Organization" value={fields.organizationId || ''} onChange={(event) => setFields({ ...fields, organizationId: event.target.value })}>
              <MenuItem value="">Unlinked</MenuItem>
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} select label="Contact" value={fields.contactId || ''} onChange={(event) => setFields({ ...fields, contactId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {contacts.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'fullName')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} select label="Lead" value={fields.leadId || ''} onChange={(event) => setFields({ ...fields, leadId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {leads.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'fullName')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} select label="Opportunity" value={fields.opportunityId || ''} onChange={(event) => setFields({ ...fields, opportunityId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {opportunities.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} label="Starts" type="datetime-local" value={fields.startsAt || ''} onChange={(event) => setFields({ ...fields, startsAt: event.target.value })} InputLabelProps={{ shrink: true }} required />
            <TextField disabled={!recordEditable} label="Ends" type="datetime-local" value={fields.endsAt || ''} onChange={(event) => setFields({ ...fields, endsAt: event.target.value })} InputLabelProps={{ shrink: true }} required />
            <TextField disabled={!recordEditable} label="Timezone" value={fields.timezone || ''} onChange={(event) => setFields({ ...fields, timezone: event.target.value })} />
            <TextField disabled={!recordEditable} label="Location" value={fields.location || ''} onChange={(event) => setFields({ ...fields, location: event.target.value })} />
            <TextField disabled={!recordEditable} label="Attendee emails" value={fields.attendeeEmails || ''} onChange={(event) => setFields({ ...fields, attendeeEmails: event.target.value })} helperText="Separate addresses with commas" />
          </>}
          {entity === 'interactions' && <>
            <TextField disabled={!recordEditable} label="Subject" value={fields.subject || ''} onChange={(event) => setFields({ ...fields, subject: event.target.value })} required />
            <TextField disabled={!recordEditable} select label="Organization" value={fields.organizationId || ''} onChange={(event) => setFields({ ...fields, organizationId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField disabled={!recordEditable} label="Type" value={fields.interactionType || ''} onChange={(event) => setFields({ ...fields, interactionType: event.target.value })} />
            <TextField disabled={!recordEditable} label="Date" type="datetime-local" value={fields.occurredAt || ''} onChange={(event) => setFields({ ...fields, occurredAt: event.target.value })} InputLabelProps={{ shrink: true }} />
            <TextField disabled={!recordEditable} label="Agent" value={fields.agentName || ''} onChange={(event) => setFields({ ...fields, agentName: event.target.value })} />
          </>}
          {entity === 'campaigns' && <>
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
          <TextField disabled={!recordEditable} label="Notes" value={fields.description || fields.notes || ''} onChange={(event) => setFields({ ...fields, description: event.target.value, notes: event.target.value })} multiline minRows={4} />
          {recordEditable && <Button variant="contained" onClick={saveRecord} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}
        </Stack>
      </Drawer>
    </Box>
  )
}
