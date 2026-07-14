'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import CloseRounded from '@mui/icons-material/CloseRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import UploadFileRounded from '@mui/icons-material/UploadFileRounded'
import WorkspaceSelector from '@/components/workspaces/WorkspaceSelector'
import type { CrmEntity, CrmSummary } from '@/lib/crm/types'

type RecordValue = Record<string, unknown>
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
  opportunities: 'Opportunities',
  interactions: 'Interactions',
}

const EMPTY_SUMMARY: CrmSummary = {
  organizations: 0,
  contacts: 0,
  opportunities: 0,
  interactions: 0,
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
    ['name', 'Organization'], ['parentOrganizationName', 'Parent'], ['relationshipType', 'Relationship'],
    ['accountManager', 'Owner'], ['phone', 'Phone'],
  ] as const
  if (entity === 'contacts') return [
    ['fullName', 'Contact'], ['organizationName', 'Organization'], ['jobTitle', 'Title'], ['email', 'Email'],
  ] as const
  if (entity === 'opportunities') return [
    ['name', 'Opportunity'], ['organization', 'Organization'], ['stage', 'Stage'], ['value', 'Value'],
  ] as const
  return [
    ['subject', 'Interaction'], ['interactionType', 'Type'], ['occurredAt', 'Date'], ['agentName', 'Agent'],
  ] as const
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
  const [workspaceHierarchy, setWorkspaceHierarchy] = useState<WorkspaceOrganization[]>([])
  const [canManageHierarchy, setCanManageHierarchy] = useState(false)
  const [suiteCrmPunchoutUrl, setSuiteCrmPunchoutUrl] = useState<string | null>(null)
  const [suiteCrmUsername, setSuiteCrmUsername] = useState<string | null>(null)
  const [suiteCrmAdminPortalUrl, setSuiteCrmAdminPortalUrl] = useState<string | null>(null)
  const [suiteCrmAccessOpen, setSuiteCrmAccessOpen] = useState(false)
  const [hierarchyOpen, setHierarchyOpen] = useState(false)

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
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load CRM records')
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(entity, '') }, [entity, load])

  const editable = Boolean(pipeline && pipeline.accessRole !== 'viewer' && entity !== 'opportunities')
  const tableColumns = useMemo(() => columns(entity), [entity])

  async function openEditor(record: RecordValue | null) {
    if (!editable) return
    setEditorRecord(record)
    setFields(initialFields(entity, record))
    if ((entity === 'contacts' || entity === 'interactions') && organizations.length === 0) {
      const response = await fetch('/api/crm?entity=organizations&limit=1000')
      const payload = await response.json().catch(() => ({})) as CrmPayload
      if (response.ok && payload.ok) setOrganizations(payload.records || [])
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
        body: JSON.stringify({ entity, id: editorRecord?.id, fields }),
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
          <Chip label={`${summary.opportunities} opportunities`} />
          <Chip label={`${summary.interactions} interactions`} />
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
          <Tabs value={entity} onChange={(_, value: CrmEntity) => { setEntity(value); setQuery('') }} variant="scrollable">
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
                  hover={editable && !record.workspaceOrganizationId}
                  onClick={() => { if (editable && !record.workspaceOrganizationId) void openEditor(record) }}
                  sx={{ cursor: editable && !record.workspaceOrganizationId ? 'pointer' : 'default' }}
                >
                  {tableColumns.map(([key]) => (
                    <TableCell key={key}>
                      {entity === 'opportunities' && key === 'value' ? money(record[key]) : textValue(record, key) || '—'}
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
          {entity === 'organizations' && <>
            <TextField label="Organization" value={fields.name || ''} onChange={(event) => setFields({ ...fields, name: event.target.value })} required />
            <TextField label="Type" value={fields.accountType || ''} onChange={(event) => setFields({ ...fields, accountType: event.target.value })} />
            <TextField label="Owner" value={fields.accountManager || ''} onChange={(event) => setFields({ ...fields, accountManager: event.target.value })} />
            <TextField label="Website" value={fields.website || ''} onChange={(event) => setFields({ ...fields, website: event.target.value })} />
            <TextField label="Phone" value={fields.phone || ''} onChange={(event) => setFields({ ...fields, phone: event.target.value })} />
          </>}
          {entity === 'contacts' && <>
            <TextField label="Contact" value={fields.fullName || ''} onChange={(event) => setFields({ ...fields, fullName: event.target.value })} required />
            <TextField select label="Organization" value={fields.organizationId || ''} onChange={(event) => setFields({ ...fields, organizationId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField label="Title" value={fields.jobTitle || ''} onChange={(event) => setFields({ ...fields, jobTitle: event.target.value })} />
            <TextField label="Email" type="email" value={fields.email || ''} onChange={(event) => setFields({ ...fields, email: event.target.value })} />
            <TextField label="Work phone" value={fields.phoneWork || ''} onChange={(event) => setFields({ ...fields, phoneWork: event.target.value })} />
            <TextField label="Mobile" value={fields.phoneMobile || ''} onChange={(event) => setFields({ ...fields, phoneMobile: event.target.value })} />
          </>}
          {entity === 'interactions' && <>
            <TextField label="Subject" value={fields.subject || ''} onChange={(event) => setFields({ ...fields, subject: event.target.value })} required />
            <TextField select label="Organization" value={fields.organizationId || ''} onChange={(event) => setFields({ ...fields, organizationId: event.target.value })}>
              <MenuItem value="">None</MenuItem>
              {organizations.map((record) => <MenuItem key={textValue(record, 'id')} value={textValue(record, 'id')}>{textValue(record, 'name')}</MenuItem>)}
            </TextField>
            <TextField label="Type" value={fields.interactionType || ''} onChange={(event) => setFields({ ...fields, interactionType: event.target.value })} />
            <TextField label="Date" type="datetime-local" value={fields.occurredAt || ''} onChange={(event) => setFields({ ...fields, occurredAt: event.target.value })} InputLabelProps={{ shrink: true }} />
            <TextField label="Agent" value={fields.agentName || ''} onChange={(event) => setFields({ ...fields, agentName: event.target.value })} />
          </>}
          <TextField label="Notes" value={fields.description || ''} onChange={(event) => setFields({ ...fields, description: event.target.value })} multiline minRows={4} />
          <Button variant="contained" onClick={saveRecord} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </Stack>
      </Drawer>
    </Box>
  )
}
