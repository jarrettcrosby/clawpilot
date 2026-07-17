'use client'

import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
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
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import CloseRounded from '@mui/icons-material/CloseRounded'
import DownloadRounded from '@mui/icons-material/DownloadRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import PersonAddRounded from '@mui/icons-material/PersonAddRounded'
import UploadFileRounded from '@mui/icons-material/UploadFileRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'

export type PipelineCatalogPerson = {
  id: string
  referenceCode: string
  displayName: string
  email: string
  jobTitle: string
  source: 'app_user' | 'external'
  appAccess: boolean
  status: string
  active: boolean
}

export type PipelineCatalogProduct = {
  id: string
  referenceCode: string
  name: string
  sku: string
  productType: string
  category: string
  status: string
  price: number
  cost: number
  currency: string
  url: string
  description: string
  active: boolean
}

export type PipelineCatalogSnapshot = {
  pipelineId: string
  canEdit: boolean
  people: PipelineCatalogPerson[]
  products: PipelineCatalogProduct[]
}

type ImportResult = {
  imported?: number
  failed?: number
  errors?: Array<{ row?: number; error?: string }>
}

type WorkflowField = 'stage' | 'priority' | 'status' | 'source' | 'loss_reason'

const WORKFLOW_FIELDS: Array<{ key: WorkflowField; label: string; helper: string }> = [
  { key: 'stage', label: 'Stages', helper: 'One pipeline lane per line, in display order.' },
  { key: 'priority', label: 'Priorities', helper: 'One priority per line, highest first.' },
  { key: 'status', label: 'Statuses', helper: 'Lifecycle statuses such as Open, Won, and Lost.' },
  { key: 'source', label: 'Sources', helper: 'Lead and opportunity source choices.' },
  { key: 'loss_reason', label: 'Loss reasons', helper: 'Reasons available when an opportunity is lost.' },
]

const DEFAULT_WORKFLOW: Record<WorkflowField, string[]> = {
  stage: ['Identified Lead', 'Qualified Lead', 'Needs Analysis', 'Demo', 'Proposal', 'Negotiation', 'Loss', 'Won'],
  priority: ['A+', 'A', 'B', 'C', 'D'],
  status: ['Open', 'On Hold', 'Closed', 'Won', 'Lost', 'Abandoned'],
  source: ['Inbound', 'Outbound', 'Referral', 'Website', 'Partner'],
  loss_reason: ['No Decision', 'Budget', 'Competition', 'Not a Fit'],
}

const EMPTY_PERSON = {
  id: '',
  fullName: '',
  email: '',
  jobTitle: '',
  active: true,
}

const EMPTY_PRODUCT = {
  id: '',
  name: '',
  sku: '',
  productType: 'Good',
  category: '',
  status: 'Active',
  price: '',
  cost: '',
  currency: 'USD',
  url: '',
  description: '',
  active: true,
}

function downloadCsvTemplate(kind: 'people' | 'products') {
  const value = kind === 'people'
    ? 'fullName,email,jobTitle,active\nTaylor Morgan,taylor@example.com,Sales Manager,true\n'
    : 'name,sku,productType,category,status,price,cost,currency,url,description,active\nConsulting,CONSULT-01,Service,Advisory,Active,250,0,USD,https://example.com/consulting,Professional services,true\n'
  const url = URL.createObjectURL(new Blob([value], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `clawpilot-${kind}-template.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function PipelineCatalogDialog({
  open,
  onClose,
  onCatalogChange,
}: {
  open: boolean
  onClose: () => void
  onCatalogChange?: (catalog: PipelineCatalogSnapshot) => void
}) {
  const fullScreen = useMediaQuery('(max-width:699.95px), (orientation: landscape) and (max-height: 500px)')
  const [tab, setTab] = useState<'people' | 'products' | 'workflow'>('people')
  const [catalog, setCatalog] = useState<PipelineCatalogSnapshot>({ pipelineId: '', canEdit: false, people: [], products: [] })
  const [person, setPerson] = useState(EMPTY_PERSON)
  const [product, setProduct] = useState(EMPTY_PRODUCT)
  const [personEditorOpen, setPersonEditorOpen] = useState(false)
  const [productEditorOpen, setProductEditorOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [workflowCatalog, setWorkflowCatalog] = useState<Record<string, unknown>>({})
  const [workflow, setWorkflow] = useState<Record<WorkflowField, string>>({
    stage: '',
    priority: '',
    status: '',
    source: '',
    loss_reason: '',
  })
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [catalogResponse, workflowResponse] = await Promise.all([
        fetch('/api/pipeline/catalog', { cache: 'no-store' }),
        fetch('/api/pipeline/dropdowns', { cache: 'no-store' }),
      ])
      const payload = await catalogResponse.json().catch(() => ({}))
      const workflowPayload = await workflowResponse.json().catch(() => ({}))
      if (!catalogResponse.ok || payload?.ok === false) throw new Error(payload?.error || 'Unable to load pipeline setup')
      if (!workflowResponse.ok || workflowPayload?.ok === false) throw new Error(workflowPayload?.error || 'Unable to load pipeline workflow')
      const next: PipelineCatalogSnapshot = {
        pipelineId: String(payload.pipelineId || ''),
        canEdit: payload.canEdit === true,
        people: Array.isArray(payload.people) ? payload.people : [],
        products: Array.isArray(payload.products) ? payload.products : [],
      }
      setCatalog(next)
      const nextWorkflowCatalog = workflowPayload?.catalog && typeof workflowPayload.catalog === 'object'
        ? workflowPayload.catalog as Record<string, unknown>
        : {}
      const dropdowns = nextWorkflowCatalog.dropdowns && typeof nextWorkflowCatalog.dropdowns === 'object'
        ? nextWorkflowCatalog.dropdowns as Record<string, unknown>
        : {}
      setWorkflowCatalog(nextWorkflowCatalog)
      setWorkflow(Object.fromEntries(WORKFLOW_FIELDS.map(({ key }) => {
        const options = Array.isArray(dropdowns[key]) ? dropdowns[key] as Array<Record<string, unknown>> : []
        const values = options
          .filter((option) => option.active !== false)
          .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0))
          .map((option) => String(option.label || option.value || '').trim())
          .filter(Boolean)
        return [key, (values.length ? values : DEFAULT_WORKFLOW[key]).join('\n')]
      })) as Record<WorkflowField, string>)
      onCatalogChange?.(next)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load pipeline setup')
    } finally {
      setLoading(false)
    }
  }, [onCatalogChange])

  useEffect(() => {
    if (!open) return
    void load()
  }, [load, open])

  const savePerson = async () => {
    if (!person.fullName.trim() || saving) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/pipeline/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `pipeline-person:${crypto.randomUUID()}` },
        body: JSON.stringify({ action: 'upsert-person', ...person }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || 'Unable to save team member')
      setPerson(EMPTY_PERSON)
      setPersonEditorOpen(false)
      setNotice('CRM-only team member saved.')
      await load()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save team member')
    } finally {
      setSaving(false)
    }
  }

  const saveProduct = async () => {
    if (!product.name.trim() || saving) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/pipeline/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `pipeline-product:${crypto.randomUUID()}` },
        body: JSON.stringify({
          action: 'upsert-product',
          ...product,
          price: Number(product.price || 0),
          cost: Number(product.cost || 0),
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || 'Unable to save product')
      setProduct(EMPTY_PRODUCT)
      setProductEditorOpen(false)
      setNotice('Product saved and queued for CRM synchronization.')
      await load()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save product')
    } finally {
      setSaving(false)
    }
  }

  const importCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || saving) return
    if (file.size > 1024 * 1024) {
      setError('CSV files must be 1 MB or smaller.')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    setImportResult(null)
    try {
      const body = new FormData()
      body.set('action', 'import')
      body.set('kind', tab)
      body.set('file', file)
      const response = await fetch('/api/pipeline/catalog', {
        method: 'POST',
        headers: { 'Idempotency-Key': `pipeline-${tab}-import:${crypto.randomUUID()}` },
        body,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || 'Unable to import CSV')
      const result = payload.import || payload.result || {}
      setImportResult(result)
      setNotice(`${Number(result.imported || 0)} ${tab === 'people' ? 'team member' : 'product'} record${Number(result.imported || 0) === 1 ? '' : 's'} imported.`)
      await load()
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Unable to import CSV')
    } finally {
      setSaving(false)
    }
  }

  const saveWorkflow = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const previousDropdowns = workflowCatalog.dropdowns && typeof workflowCatalog.dropdowns === 'object'
        ? workflowCatalog.dropdowns as Record<string, unknown>
        : {}
      const dropdowns = { ...previousDropdowns }
      for (const { key } of WORKFLOW_FIELDS) {
        const seen = new Set<string>()
        const values = workflow[key]
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter((value) => {
            const normalized = value.toLowerCase()
            if (!value || seen.has(normalized)) return false
            seen.add(normalized)
            return true
          })
        if (values.length === 0) throw new Error(`${WORKFLOW_FIELDS.find((field) => field.key === key)?.label || key} must include at least one value`)
        dropdowns[key] = values.map((value, index) => ({ value, label: value, active: true, sort_order: index }))
      }
      const response = await fetch('/api/pipeline/dropdowns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `pipeline-workflow:${crypto.randomUUID()}` },
        body: JSON.stringify({ ...workflowCatalog, source: 'app', dropdowns }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || 'Unable to save pipeline workflow')
      setNotice(payload.syncStatus === 'queued' ? 'Workflow saved. Google Sheet synchronization is queued.' : 'Workflow saved for this pipeline.')
      await load()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save pipeline workflow')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="md"
      PaperProps={{ sx: { bgcolor: '#16161E', border: '1px solid rgba(255,255,255,0.08)', borderRadius: fullScreen ? 0 : 1, maxHeight: fullScreen ? '100dvh' : 'min(820px, 92dvh)' } }}
    >
      <DialogTitle sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" fontWeight={700}>Pipeline setup</Typography>
            <Typography variant="body2" color="text.secondary">People, products, and workflow for this organization</Typography>
          </Box>
          <IconButton aria-label="Close pipeline setup" onClick={onClose} disabled={saving}><CloseRounded /></IconButton>
        </Stack>
      </DialogTitle>
      <Tabs
        value={tab}
        onChange={(_, value) => { setTab(value); setImportResult(null); setError(''); setNotice('') }}
        variant="fullWidth"
        sx={{ borderTop: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <Tab value="people" label={`People (${catalog.people.length})`} />
        <Tab value="products" label={`Products (${catalog.products.length})`} />
        <Tab value="workflow" label="Workflow" />
      </Tabs>
      <DialogContent sx={{ p: { xs: 2, sm: 3 }, overflowX: 'hidden' }}>
        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}
        {importResult?.errors?.length ? (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {Number(importResult.failed || importResult.errors.length)} row{Number(importResult.failed || importResult.errors.length) === 1 ? '' : 's'} need review: {importResult.errors.slice(0, 3).map((item) => `row ${item.row || '?'} ${item.error || 'invalid'}`).join('; ')}
          </Alert>
        ) : null}

        <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} mb={2}>
          <Typography variant="body2" color="text.secondary">
            {tab === 'people'
              ? 'ClawPilot users are included automatically. CRM-only people can own pipeline work without receiving application access.'
              : tab === 'products'
                ? 'Active CRM products are the only products offered when creating or editing opportunities.'
                : 'These choices and their order apply only to the selected pipeline.'}
          </Typography>
          {catalog.canEdit && tab !== 'workflow' ? (
            <Stack direction="row" gap={0.5} flexShrink={0}>
              <Tooltip title={`Download ${tab} CSV template`}>
                <IconButton aria-label={`Download ${tab} CSV template`} onClick={() => downloadCsvTemplate(tab)}><DownloadRounded /></IconButton>
              </Tooltip>
              <Tooltip title={`Import ${tab} CSV`}>
                <span>
                  <IconButton aria-label={`Import ${tab} CSV`} disabled={saving} onClick={() => fileInputRef.current?.click()}><UploadFileRounded /></IconButton>
                </span>
              </Tooltip>
              <input ref={fileInputRef} hidden type="file" accept=".csv,text/csv" onChange={importCsv} />
              <Button
                variant="outlined"
                size="small"
                startIcon={tab === 'people' ? <PersonAddRounded /> : <Inventory2Rounded />}
                onClick={() => {
                  if (tab === 'people') { setPerson(EMPTY_PERSON); setPersonEditorOpen(true) }
                  else { setProduct(EMPTY_PRODUCT); setProductEditorOpen(true) }
                }}
              >
                Add {tab === 'people' ? 'person' : 'product'}
              </Button>
            </Stack>
          ) : null}
        </Stack>

        {loading ? (
          <Stack alignItems="center" py={6}><CircularProgress size={26} /></Stack>
        ) : tab === 'people' ? (
          <List disablePadding aria-label="Pipeline people">
            {catalog.people.map((item, index) => (
              <Box key={item.id || item.email}>
                {index ? <Divider /> : null}
                <ListItem
                  disableGutters
                  secondaryAction={item.source === 'external' && catalog.canEdit ? (
                    <Tooltip title="Edit CRM-only team member">
                      <IconButton aria-label={`Edit ${item.displayName}`} onClick={() => {
                        setPerson({ id: item.id, fullName: item.displayName, email: item.email, jobTitle: item.jobTitle, active: item.active })
                        setPersonEditorOpen(true)
                      }}><EditRounded /></IconButton>
                    </Tooltip>
                  ) : null}
                >
                  <ListItemText
                    primary={<Stack direction="row" gap={1} alignItems="center" flexWrap="wrap"><span>{item.displayName}</span><Chip size="small" label={item.appAccess ? 'ClawPilot access' : 'CRM only'} color={item.appAccess ? 'primary' : 'default'} variant="outlined" /><Chip size="small" label={item.active ? item.status || 'Active' : 'Inactive'} color={item.active ? 'success' : 'default'} variant="outlined" /></Stack>}
                    secondary={[item.jobTitle, item.email, item.referenceCode].filter(Boolean).join(' · ')}
                    primaryTypographyProps={{ component: 'div', fontWeight: 600, sx: { pr: 5, overflowWrap: 'anywhere' } }}
                    secondaryTypographyProps={{ sx: { mt: 0.5, pr: 5, overflowWrap: 'anywhere' } }}
                  />
                </ListItem>
              </Box>
            ))}
            {catalog.people.length === 0 ? <Typography color="text.secondary" py={4}>No pipeline people configured.</Typography> : null}
          </List>
        ) : tab === 'products' ? (
          <List disablePadding aria-label="Pipeline products">
            {catalog.products.map((item, index) => (
              <Box key={item.id}>
                {index ? <Divider /> : null}
                <ListItem
                  disableGutters
                  secondaryAction={catalog.canEdit ? (
                    <Tooltip title="Edit product">
                      <IconButton aria-label={`Edit ${item.name}`} onClick={() => {
                        setProduct({
                          id: item.id,
                          name: item.name,
                          sku: item.sku,
                          productType: item.productType,
                          category: item.category,
                          status: item.status,
                          price: String(item.price || ''),
                          cost: String(item.cost || ''),
                          currency: item.currency || 'USD',
                          url: item.url,
                          description: item.description,
                          active: item.active,
                        })
                        setProductEditorOpen(true)
                      }}><EditRounded /></IconButton>
                    </Tooltip>
                  ) : null}
                >
                  <ListItemText
                    primary={<Stack direction="row" gap={1} alignItems="center" flexWrap="wrap"><span>{item.name}</span><Chip size="small" label={item.active ? item.status || 'Active' : 'Inactive'} color={item.active ? 'success' : 'default'} variant="outlined" /></Stack>}
                    secondary={[
                      item.sku || item.referenceCode,
                      item.category,
                      item.price ? `${item.currency || 'USD'} ${Number(item.price).toLocaleString()}` : '',
                    ].filter(Boolean).join(' · ')}
                    primaryTypographyProps={{ component: 'div', fontWeight: 600, sx: { pr: 5, overflowWrap: 'anywhere' } }}
                    secondaryTypographyProps={{ sx: { mt: 0.5, pr: 5, overflowWrap: 'anywhere' } }}
                  />
                </ListItem>
              </Box>
            ))}
            {catalog.products.length === 0 ? <Typography color="text.secondary" py={4}>Add products before creating an opportunity.</Typography> : null}
          </List>
        ) : (
          <Box component="section" aria-label="Pipeline workflow fields">
            <Stack gap={2}>
              {WORKFLOW_FIELDS.map((field) => (
                <TextField
                  key={field.key}
                  disabled={!catalog.canEdit}
                  multiline
                  minRows={field.key === 'stage' ? 5 : 3}
                  label={field.label}
                  value={workflow[field.key]}
                  onChange={(event) => setWorkflow({ ...workflow, [field.key]: event.target.value })}
                  helperText={field.helper}
                />
              ))}
              {catalog.canEdit ? (
                <Button variant="contained" onClick={() => { void saveWorkflow() }} disabled={saving} sx={{ alignSelf: { xs: 'stretch', sm: 'flex-end' } }}>
                  {saving ? 'Saving…' : 'Save workflow'}
                </Button>
              ) : null}
            </Stack>
          </Box>
        )}

        {personEditorOpen ? (
          <Box component="section" aria-label="CRM-only team member editor" sx={{ mt: 2, pt: 2, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <Typography variant="subtitle1" fontWeight={700} mb={1.5}>{person.id ? 'Edit CRM-only team member' : 'Add CRM-only team member'}</Typography>
            <Stack gap={1.5}>
              <TextField required label="Full name" value={person.fullName} onChange={(event) => setPerson({ ...person, fullName: event.target.value })} />
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField fullWidth label="Email" type="email" value={person.email} onChange={(event) => setPerson({ ...person, email: event.target.value })} />
                <TextField fullWidth label="Job title" value={person.jobTitle} onChange={(event) => setPerson({ ...person, jobTitle: event.target.value })} />
              </Stack>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="body2">Available in pipeline owner lists</Typography>
                <Switch checked={person.active} onChange={(event) => setPerson({ ...person, active: event.target.checked })} />
              </Stack>
              <Stack direction="row" justifyContent="flex-end" gap={1}>
                <Button onClick={() => setPersonEditorOpen(false)} disabled={saving}>Cancel</Button>
                <Button variant="contained" onClick={() => { void savePerson() }} disabled={saving || !person.fullName.trim()}>{saving ? 'Saving…' : 'Save person'}</Button>
              </Stack>
            </Stack>
          </Box>
        ) : null}

        {productEditorOpen ? (
          <Box component="section" aria-label="Product editor" sx={{ mt: 2, pt: 2, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <Typography variant="subtitle1" fontWeight={700} mb={1.5}>{product.id ? 'Edit product' : 'Add product'}</Typography>
            <Stack gap={1.5}>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField fullWidth required label="Product name" value={product.name} onChange={(event) => setProduct({ ...product, name: event.target.value })} />
                <TextField fullWidth label="SKU" value={product.sku} inputProps={{ maxLength: 25 }} onChange={(event) => setProduct({ ...product, sku: event.target.value.slice(0, 25) })} helperText="Up to 25 characters" />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField fullWidth label="Type" value={product.productType} onChange={(event) => setProduct({ ...product, productType: event.target.value })} />
                <TextField fullWidth label="Category" value={product.category} onChange={(event) => setProduct({ ...product, category: event.target.value })} />
                <TextField fullWidth label="Status" value={product.status} onChange={(event) => setProduct({ ...product, status: event.target.value })} />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
                <TextField fullWidth label="Price" inputMode="decimal" value={product.price} onChange={(event) => setProduct({ ...product, price: event.target.value.replace(/[^0-9.-]/g, '') })} />
                <TextField fullWidth label="Cost" inputMode="decimal" value={product.cost} onChange={(event) => setProduct({ ...product, cost: event.target.value.replace(/[^0-9.-]/g, '') })} />
                <TextField fullWidth label="Currency" value={product.currency} inputProps={{ maxLength: 3 }} onChange={(event) => setProduct({ ...product, currency: event.target.value.toUpperCase() })} />
              </Stack>
              <TextField label="Product URL" type="url" value={product.url} onChange={(event) => setProduct({ ...product, url: event.target.value })} />
              <TextField multiline minRows={3} label="Description" value={product.description} onChange={(event) => setProduct({ ...product, description: event.target.value })} />
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="body2">Available when selecting products</Typography>
                <Switch checked={product.active} onChange={(event) => setProduct({ ...product, active: event.target.checked })} />
              </Stack>
              <Stack direction="row" justifyContent="flex-end" gap={1}>
                <Button onClick={() => setProductEditorOpen(false)} disabled={saving}>Cancel</Button>
                <Button variant="contained" onClick={() => { void saveProduct() }} disabled={saving || !product.name.trim()}>{saving ? 'Saving…' : 'Save product'}</Button>
              </Stack>
            </Stack>
          </Box>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <Button onClick={onClose} disabled={saving}>Done</Button>
      </DialogActions>
    </Dialog>
  )
}
