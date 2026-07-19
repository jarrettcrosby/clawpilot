'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AddRounded from '@mui/icons-material/AddRounded'
import CancelOutlined from '@mui/icons-material/CancelOutlined'
import CloseRounded from '@mui/icons-material/CloseRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import Inventory2Outlined from '@mui/icons-material/Inventory2Outlined'
import PersonAddAltOutlined from '@mui/icons-material/PersonAddAltOutlined'
import ReceiptLongOutlined from '@mui/icons-material/ReceiptLongOutlined'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SendRounded from '@mui/icons-material/SendRounded'
import VerifiedOutlined from '@mui/icons-material/VerifiedOutlined'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type OperationKind = 'customer.create' | 'item.create' | 'invoice.create'
type RequestStatus = 'draft' | 'pending_approval' | 'approved' | 'processing' | 'succeeded' | 'failed' | 'dead' | 'cancelled'
type Capabilities = { canView: boolean; canManage: boolean; canPrepare: boolean; canApprove: boolean }

type WriteRequest = {
  id: string
  operationKind: OperationKind
  status: RequestStatus
  providerRequestId: string
  requestPayload: Record<string, unknown>
  requestFingerprint: string
  providerEntityType: string | null
  providerEntityId: string | null
  requestedBy: string
  requestedByName: string | null
  approvedBy: string | null
  approvedByName: string | null
  approvalNote: string | null
  attemptCount: number
  maxAttempts: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
  createdAt: string
  approvedAt: string | null
  postedAt: string | null
}

type ReferenceData = {
  customers: Array<{ id: string; displayName: string; companyName: string | null; email: string | null }>
  items: Array<{ id: string; name: string; itemType: string; unitPrice: number; description: string | null }>
  accounts: Array<{ id: string; name: string; classification: string | null; accountType: string | null }>
}

type Workspace = {
  capabilities: Capabilities
  connection: {
    companyName: string
    writeMode: 'disabled' | 'sandbox' | 'production'
    writeVerifiedAt: string | null
    postingEnabled: boolean
    currencyCode: string | null
  }
  requests: WriteRequest[]
  referenceData: ReferenceData
  total: number
}

type InvoiceLine = { key: string; itemId: string; description: string; quantity: string; unitPrice: string }
type CustomerFormValue = {
  displayName: string; companyName: string; givenName: string; familyName: string
  email: string; phone: string; notes: string; line1: string; line2: string
  city: string; region: string; postalCode: string; country: string
}
type ItemFormValue = {
  name: string; itemType: string; sku: string; description: string; unitPrice: string
  purchaseCost: string; incomeAccountId: string; expenseAccountId: string; taxable: boolean
}
type InvoiceFormValue = {
  customerId: string; transactionDate: string; dueDate: string; billingEmail: string; customerMemo: string
}

const operationLabels: Record<OperationKind, string> = {
  'customer.create': 'New customer',
  'item.create': 'New product or service',
  'invoice.create': 'New invoice',
}

const statusLabels: Record<RequestStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Needs approval',
  approved: 'Approved',
  processing: 'Posting',
  succeeded: 'Posted',
  failed: 'Retrying',
  dead: 'Needs review',
  cancelled: 'Cancelled',
}

const statusColors: Record<RequestStatus, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  draft: 'default',
  pending_approval: 'warning',
  approved: 'info',
  processing: 'info',
  succeeded: 'success',
  failed: 'warning',
  dead: 'error',
  cancelled: 'default',
}

const drawerSx = {
  width: { xs: '100%', sm: 520 },
  maxWidth: '100vw',
  bgcolor: '#171821',
  backgroundImage: 'none',
}

const fieldSx = { '& .MuiOutlinedInput-root': { borderRadius: '8px' } }

function newClientRequestId() {
  return globalThis.crypto.randomUUID()
}

function today() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function newLine(): InvoiceLine {
  return { key: newClientRequestId(), itemId: '', description: '', quantity: '1', unitPrice: '' }
}

function requestTitle(request: WriteRequest) {
  const payload = request.requestPayload
  if (request.operationKind === 'customer.create') return String(payload.displayName || 'Customer')
  if (request.operationKind === 'item.create') return String(payload.name || 'Product or service')
  return String(payload.customerName || 'Invoice')
}

function requestAmount(request: WriteRequest) {
  return request.operationKind === 'invoice.create' ? Number(request.requestPayload.totalAmount || 0) : null
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <Box>
      <Typography variant="caption" color="text.disabled" display="block">{label}</Typography>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(value)}</Typography>
    </Box>
  )
}

function RequestReview({ request, money }: { request: WriteRequest; money: (value: number) => string }) {
  const payload = request.requestPayload
  const lines = Array.isArray(payload.lines) ? payload.lines as Array<Record<string, unknown>> : []
  return (
    <Stack spacing={2}>
      <Box display="flex" gap={1} flexWrap="wrap">
        <Chip size="small" color={statusColors[request.status]} label={statusLabels[request.status]} />
        <Chip size="small" variant="outlined" label={operationLabels[request.operationKind]} />
      </Box>
      <DetailField label="Record" value={requestTitle(request)} />
      <DetailField label="Company" value={payload.companyName} />
      <DetailField label="Email" value={payload.email || payload.billingEmail} />
      <DetailField label="Phone" value={payload.phone} />
      <DetailField label="Type" value={payload.itemType} />
      <DetailField label="SKU" value={payload.sku} />
      <DetailField label="Description" value={payload.description || payload.notes} />
      <DetailField label="Invoice date" value={payload.transactionDate} />
      <DetailField label="Due date" value={payload.dueDate} />
      <DetailField label="Customer memo" value={payload.customerMemo} />
      {lines.length ? (
        <Box>
          <Typography fontWeight={700} mb={1}>Invoice line items</Typography>
          <Stack divider={<Divider flexItem />} spacing={1.25}>
            {lines.map((line, index) => (
              <Box key={`${String(line.itemId)}-${index}`} display="grid" gridTemplateColumns="minmax(0, 1fr) auto" gap={1.5}>
                <Box minWidth={0}>
                  <Typography variant="body2" fontWeight={650}>{String(line.itemName || 'Line item')}</Typography>
                  {line.description ? <Typography variant="caption" color="text.secondary">{String(line.description)}</Typography> : null}
                  <Typography variant="caption" display="block" color="text.disabled">{String(line.quantity)} x {money(Number(line.unitPrice || 0))}</Typography>
                </Box>
                <Typography variant="body2" fontWeight={650}>{money(Number(line.amount || 0))}</Typography>
              </Box>
            ))}
          </Stack>
          <Box display="flex" justifyContent="space-between" mt={1.5} pt={1.5} borderTop="1px solid rgba(255,255,255,0.1)">
            <Typography fontWeight={700}>Total</Typography>
            <Typography fontWeight={700}>{money(Number(payload.totalAmount || 0))}</Typography>
          </Box>
        </Box>
      ) : null}
      <Divider />
      <DetailField label="Prepared by" value={request.requestedByName || request.requestedBy} />
      <DetailField label="Approved by" value={request.approvedByName || request.approvedBy} />
      <DetailField label="Approval note" value={request.approvalNote} />
      <DetailField label="Provider request ID" value={request.providerRequestId} />
      <DetailField label="QuickBooks record" value={request.providerEntityId ? `${request.providerEntityType || 'Record'} ${request.providerEntityId}` : null} />
      <DetailField label="Request fingerprint" value={request.requestFingerprint} />
      {request.lastErrorMessage ? <Alert severity="error">{request.lastErrorMessage}</Alert> : null}
    </Stack>
  )
}

export default function QuickBooksActionsPanel() {
  const dateTimeSettings = useUserDateTime()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [formKind, setFormKind] = useState<OperationKind | null>(null)
  const [formRequestId, setFormRequestId] = useState(newClientRequestId)
  const [selected, setSelected] = useState<WriteRequest | null>(null)
  const [customer, setCustomer] = useState({
    displayName: '', companyName: '', givenName: '', familyName: '', email: '', phone: '', notes: '',
    line1: '', line2: '', city: '', region: '', postalCode: '', country: '',
  })
  const [item, setItem] = useState({
    name: '', itemType: 'Service', sku: '', description: '', unitPrice: '', purchaseCost: '',
    incomeAccountId: '', expenseAccountId: '', taxable: false,
  })
  const [invoice, setInvoice] = useState({
    customerId: '', transactionDate: today(), dueDate: '', billingEmail: '', customerMemo: '',
  })
  const [invoiceLines, setInvoiceLines] = useState<InvoiceLine[]>([newLine()])

  const money = useMemo(() => (amount: number) => {
    const currency = workspace?.connection.currencyCode
    return new Intl.NumberFormat(dateTimeSettings.locale, currency ? {
      style: 'currency', currency, maximumFractionDigits: 2,
    } : { maximumFractionDigits: 2 }).format(Number(amount || 0))
  }, [dateTimeSettings.locale, workspace?.connection.currencyCode])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/accounting/quickbooks/actions?pageSize=100', { cache: 'no-store' })
      const payload = await response.json() as ({ ok?: boolean; error?: string } & Partial<Workspace>)
      if (!response.ok || !payload.ok || !payload.connection || !payload.capabilities || !payload.requests || !payload.referenceData) {
        throw new Error(payload.error || 'Accounting actions are unavailable')
      }
      setWorkspace(payload as Workspace)
      setSelected((current) => current ? payload.requests!.find((request) => request.id === current.id) || null : null)
    } catch (loadError) {
      setError((loadError as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  function openForm(kind: OperationKind) {
    setFormRequestId(newClientRequestId())
    setFormKind(kind)
    setError(null)
    setNotice(null)
    if (kind === 'customer.create') {
      setCustomer({ displayName: '', companyName: '', givenName: '', familyName: '', email: '', phone: '', notes: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: '' })
    } else if (kind === 'item.create') {
      setItem({ name: '', itemType: 'Service', sku: '', description: '', unitPrice: '', purchaseCost: '', incomeAccountId: '', expenseAccountId: '', taxable: false })
    } else {
      setInvoice({ customerId: '', transactionDate: today(), dueDate: '', billingEmail: '', customerMemo: '' })
      setInvoiceLines([newLine()])
    }
  }

  async function saveDraft() {
    if (!formKind) return
    setBusy(true)
    setError(null)
    setNotice(null)
    let payload: Record<string, unknown>
    if (formKind === 'customer.create') {
      payload = {
        displayName: customer.displayName,
        companyName: customer.companyName,
        givenName: customer.givenName,
        familyName: customer.familyName,
        email: customer.email,
        phone: customer.phone,
        notes: customer.notes,
        billingAddress: {
          line1: customer.line1, line2: customer.line2, city: customer.city,
          region: customer.region, postalCode: customer.postalCode, country: customer.country,
        },
      }
    } else if (formKind === 'item.create') {
      payload = { ...item, unitPrice: item.unitPrice, purchaseCost: item.purchaseCost }
    } else {
      payload = {
        ...invoice,
        lines: invoiceLines.map((line) => ({
          itemId: line.itemId,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        })),
      }
    }
    try {
      const response = await fetch('/api/accounting/quickbooks/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRequestId: formRequestId, operationKind: formKind, payload }),
      })
      const result = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to create accounting draft')
      setFormKind(null)
      setNotice('Accounting draft created')
      await load()
    } catch (saveError) {
      setError((saveError as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function transition(request: WriteRequest, action: 'submit' | 'approve' | 'cancel' | 'retry') {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/accounting/quickbooks/actions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: request.id,
          action,
          confirmFingerprint: action === 'approve' ? request.requestFingerprint : undefined,
        }),
      })
      const payload = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to update accounting draft')
      setNotice(action === 'approve' ? 'Accounting change approved' : action === 'submit' ? 'Draft submitted for approval' : action === 'retry' ? 'Accounting change queued for retry' : 'Accounting change cancelled')
      await load()
    } catch (transitionError) {
      setError((transitionError as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const incomeAccounts = workspace?.referenceData.accounts.filter((account) => account.classification === 'Revenue' || /income/i.test(account.accountType || '')) || []
  const expenseAccounts = workspace?.referenceData.accounts.filter((account) => account.classification === 'Expense' || /expense|cost of goods sold/i.test(account.accountType || '')) || []
  const invoiceTotal = invoiceLines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0)

  if (loading && !workspace) return <Box display="grid" sx={{ placeItems: 'center' }} minHeight={320}><CircularProgress /></Box>

  return (
    <Stack spacing={2.25}>
      {error ? <Alert severity="error" onClose={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice(null)}>{notice}</Alert> : null}

      {workspace ? (
        <>
          <Box display="flex" alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" gap={1.5} flexDirection={{ xs: 'column', sm: 'row' }}>
            <Box>
              <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
                <Typography variant="h6" fontWeight={700}>Accounting actions</Typography>
                <Chip
                  size="small"
                  color={workspace.connection.postingEnabled ? 'success' : 'warning'}
                  variant="outlined"
                  label={workspace.connection.postingEnabled ? `${workspace.connection.writeMode} posting enabled` : 'Provider posting disabled'}
                />
              </Box>
              <Typography variant="body2" color="text.secondary" mt={0.25}>
                Drafts require review and approval before a provider request can run.
              </Typography>
            </Box>
            <Box display="flex" gap={0.75} flexWrap="wrap">
              {workspace.capabilities.canPrepare ? (
                <>
                  <Button size="small" variant="outlined" startIcon={<PersonAddAltOutlined />} onClick={() => openForm('customer.create')}>Customer</Button>
                  <Button size="small" variant="outlined" startIcon={<Inventory2Outlined />} onClick={() => openForm('item.create')}>Product</Button>
                  <Button size="small" variant="contained" startIcon={<ReceiptLongOutlined />} onClick={() => openForm('invoice.create')}>Invoice</Button>
                </>
              ) : null}
              <Tooltip title="Refresh action status"><span><IconButton size="small" aria-label="Refresh accounting actions" onClick={() => { void load() }} disabled={loading}><RefreshRounded /></IconButton></span></Tooltip>
            </Box>
          </Box>

          {!workspace.connection.postingEnabled ? (
            <Alert severity="info" variant="outlined">
              Drafting and approval are available. Posting remains held until the organization connection and server runtime are verified for the same QuickBooks environment.
            </Alert>
          ) : null}

          <Box sx={{ border: '1px solid rgba(255,255,255,0.09)', borderRadius: '8px', overflow: 'hidden', bgcolor: '#15151D' }}>
            <TableContainer sx={{ display: { xs: 'none', md: 'block' } }}>
              <Table size="small" aria-label="QuickBooks accounting actions">
                <TableHead>
                  <TableRow>
                    {['Change', 'Record', 'Prepared by', 'Created', 'Status', 'Actions'].map((label) => <TableCell key={label} sx={{ bgcolor: '#171821', color: 'text.secondary', fontWeight: 700 }}>{label}</TableCell>)}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {workspace.requests.map((request) => (
                    <TableRow key={request.id} hover onClick={() => setSelected(request)} sx={{ cursor: 'pointer', '& td': { borderColor: 'rgba(255,255,255,0.065)' } }}>
                      <TableCell>{operationLabels[request.operationKind]}</TableCell>
                      <TableCell><Typography variant="body2" fontWeight={650}>{requestTitle(request)}</Typography>{requestAmount(request) !== null ? <Typography variant="caption" color="text.secondary">{money(requestAmount(request)!)}</Typography> : null}</TableCell>
                      <TableCell>{request.requestedByName || request.requestedBy}</TableCell>
                      <TableCell>{formatUserDateTime(request.createdAt, dateTimeSettings, { dateStyle: 'medium', timeStyle: 'short' })}</TableCell>
                      <TableCell><Chip size="small" color={statusColors[request.status]} label={statusLabels[request.status]} /></TableCell>
                      <TableCell onClick={(event) => event.stopPropagation()}><RequestActions request={request} capabilities={workspace.capabilities} busy={busy} onAction={transition} onReview={() => setSelected(request)} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Box sx={{ display: { xs: 'block', md: 'none' } }}>
              {workspace.requests.map((request) => (
                <Box key={request.id} borderBottom="1px solid rgba(255,255,255,0.07)" p={1.75}>
                  <Box component="button" type="button" onClick={() => setSelected(request)} sx={{ width: '100%', border: 0, bgcolor: 'transparent', color: 'inherit', p: 0, textAlign: 'left' }}>
                    <Box display="flex" justifyContent="space-between" gap={1.5}>
                      <Box minWidth={0}><Typography fontWeight={650}>{requestTitle(request)}</Typography><Typography variant="caption" color="text.secondary">{operationLabels[request.operationKind]}</Typography></Box>
                      <Chip size="small" color={statusColors[request.status]} label={statusLabels[request.status]} />
                    </Box>
                    <Typography variant="caption" color="text.disabled" display="block" mt={0.75}>{request.requestedByName || request.requestedBy} · {formatUserDateTime(request.createdAt, dateTimeSettings, { dateStyle: 'medium', timeStyle: 'short' })}</Typography>
                  </Box>
                  <Box mt={1.25}><RequestActions request={request} capabilities={workspace.capabilities} busy={busy} onAction={transition} onReview={() => setSelected(request)} /></Box>
                </Box>
              ))}
            </Box>
            {!workspace.requests.length ? <Box minHeight={240} display="grid" sx={{ placeItems: 'center' }} p={2}><Typography color="text.secondary">No accounting changes have been drafted.</Typography></Box> : null}
          </Box>
        </>
      ) : null}

      <Drawer anchor="right" open={Boolean(formKind)} onClose={() => { if (!busy) setFormKind(null) }} PaperProps={{ sx: drawerSx }}>
        {formKind ? (
          <Box height="100%" display="flex" flexDirection="column">
            <Box px={2.5} py={2} display="flex" alignItems="center" justifyContent="space-between">
              <Box><Typography variant="h6" fontWeight={700}>{operationLabels[formKind]}</Typography><Typography variant="caption" color="text.secondary">Save as an immutable review draft</Typography></Box>
              <IconButton aria-label="Close accounting draft" onClick={() => setFormKind(null)} disabled={busy}><CloseRounded /></IconButton>
            </Box>
            <Divider />
            <Box flex={1} overflow="auto" p={2.5}>
              {formKind === 'customer.create' ? <CustomerForm value={customer} onChange={setCustomer} /> : null}
              {formKind === 'item.create' ? <ItemForm value={item} onChange={setItem} incomeAccounts={incomeAccounts} expenseAccounts={expenseAccounts} /> : null}
              {formKind === 'invoice.create' && workspace ? (
                <InvoiceForm
                  value={invoice}
                  onChange={setInvoice}
                  lines={invoiceLines}
                  onLinesChange={setInvoiceLines}
                  customers={workspace.referenceData.customers}
                  items={workspace.referenceData.items}
                  total={invoiceTotal}
                  money={money}
                />
              ) : null}
            </Box>
            <Divider />
            <Box p={2} display="flex" justifyContent="flex-end" gap={1}>
              <Button onClick={() => setFormKind(null)} disabled={busy}>Cancel</Button>
              <Button variant="contained" startIcon={busy ? <CircularProgress size={16} /> : <AddRounded />} onClick={() => { void saveDraft() }} disabled={busy}>Create draft</Button>
            </Box>
          </Box>
        ) : null}
      </Drawer>

      <Drawer anchor="right" open={Boolean(selected)} onClose={() => setSelected(null)} PaperProps={{ sx: drawerSx }}>
        {selected ? (
          <Box height="100%" display="flex" flexDirection="column">
            <Box px={2.5} py={2} display="flex" alignItems="flex-start" justifyContent="space-between" gap={2}>
              <Box minWidth={0}><Typography variant="caption" color="text.secondary" textTransform="uppercase">{operationLabels[selected.operationKind]}</Typography><Typography variant="h6" fontWeight={700}>{requestTitle(selected)}</Typography></Box>
              <IconButton aria-label="Close accounting review" onClick={() => setSelected(null)}><CloseRounded /></IconButton>
            </Box>
            <Divider />
            <Box flex={1} overflow="auto" p={2.5}><RequestReview request={selected} money={money} /></Box>
            {workspace ? <><Divider /><Box p={2}><RequestActions request={selected} capabilities={workspace.capabilities} busy={busy} onAction={transition} reviewMode /></Box></> : null}
          </Box>
        ) : null}
      </Drawer>
    </Stack>
  )
}

function RequestActions({ request, capabilities, busy, onAction, onReview, reviewMode = false }: {
  request: WriteRequest
  capabilities: Capabilities
  busy: boolean
  onAction: (request: WriteRequest, action: 'submit' | 'approve' | 'cancel' | 'retry') => Promise<void>
  onReview?: () => void
  reviewMode?: boolean
}) {
  return (
    <Box display="flex" gap={0.75} flexWrap="wrap">
      {request.status === 'draft' && capabilities.canPrepare ? <Button size="small" startIcon={<SendRounded />} onClick={() => { void onAction(request, 'submit') }} disabled={busy}>Submit</Button> : null}
      {request.status === 'pending_approval' && capabilities.canApprove && reviewMode ? <Button size="small" variant="contained" color="success" startIcon={<VerifiedOutlined />} onClick={() => { void onAction(request, 'approve') }} disabled={busy}>Approve & queue</Button> : null}
      {(request.status === 'failed' || request.status === 'dead') && capabilities.canApprove && reviewMode ? <Button size="small" variant="outlined" startIcon={<RefreshRounded />} onClick={() => { void onAction(request, 'retry') }} disabled={busy}>Approve retry</Button> : null}
      {(['pending_approval', 'failed', 'dead'].includes(request.status)) && capabilities.canApprove && !reviewMode && onReview ? <Button size="small" variant="outlined" startIcon={<VerifiedOutlined />} onClick={onReview} disabled={busy}>Review</Button> : null}
      {['draft', 'pending_approval', 'approved', 'failed', 'dead'].includes(request.status) && (capabilities.canPrepare || capabilities.canApprove) ? <Button size="small" color="inherit" startIcon={<CancelOutlined />} onClick={() => { void onAction(request, 'cancel') }} disabled={busy}>Cancel</Button> : null}
    </Box>
  )
}

function CustomerForm({ value, onChange }: { value: CustomerFormValue; onChange: (value: CustomerFormValue) => void }) {
  const field = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: event.target.value })
  return (
    <Stack spacing={2}>
      <TextField required label="Display name" value={value.displayName} onChange={field('displayName')} sx={fieldSx} />
      <TextField label="Company name" value={value.companyName} onChange={field('companyName')} sx={fieldSx} />
      <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1.5}><TextField label="First name" value={value.givenName} onChange={field('givenName')} sx={fieldSx} /><TextField label="Last name" value={value.familyName} onChange={field('familyName')} sx={fieldSx} /></Box>
      <TextField type="email" label="Email" value={value.email} onChange={field('email')} sx={fieldSx} />
      <TextField label="Phone" value={value.phone} onChange={field('phone')} sx={fieldSx} />
      <Typography fontWeight={700} pt={0.5}>Billing address</Typography>
      <TextField label="Address line 1" value={value.line1} onChange={field('line1')} sx={fieldSx} />
      <TextField label="Address line 2" value={value.line2} onChange={field('line2')} sx={fieldSx} />
      <Box display="grid" gridTemplateColumns="1.5fr 1fr" gap={1.5}><TextField label="City" value={value.city} onChange={field('city')} sx={fieldSx} /><TextField label="State or region" value={value.region} onChange={field('region')} sx={fieldSx} /></Box>
      <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1.5}><TextField label="Postal code" value={value.postalCode} onChange={field('postalCode')} sx={fieldSx} /><TextField label="Country" value={value.country} onChange={field('country')} sx={fieldSx} /></Box>
      <TextField label="Notes" multiline minRows={3} value={value.notes} onChange={field('notes')} sx={fieldSx} />
    </Stack>
  )
}

function ItemForm({ value, onChange, incomeAccounts, expenseAccounts }: {
  value: ItemFormValue
  onChange: (value: ItemFormValue) => void
  incomeAccounts: ReferenceData['accounts']
  expenseAccounts: ReferenceData['accounts']
}) {
  const field = (key: Exclude<keyof ItemFormValue, 'taxable'>) => (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: event.target.value })
  return (
    <Stack spacing={2}>
      <TextField required label="Name" value={value.name} onChange={field('name')} sx={fieldSx} />
      <TextField select required label="Type" value={value.itemType} onChange={field('itemType')} sx={fieldSx}><MenuItem value="Service">Service</MenuItem><MenuItem value="NonInventory">Non-inventory</MenuItem></TextField>
      <TextField label="SKU" value={value.sku} onChange={field('sku')} sx={fieldSx} />
      <TextField label="Description" multiline minRows={3} value={value.description} onChange={field('description')} sx={fieldSx} />
      <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1.5}><TextField type="number" label="Sales price" value={value.unitPrice} onChange={field('unitPrice')} inputProps={{ min: 0, step: '0.01' }} sx={fieldSx} /><TextField type="number" label="Purchase cost" value={value.purchaseCost} onChange={field('purchaseCost')} inputProps={{ min: 0, step: '0.01' }} sx={fieldSx} /></Box>
      <TextField select required label="Income account" value={value.incomeAccountId} onChange={field('incomeAccountId')} sx={fieldSx}>{incomeAccounts.map((account) => <MenuItem key={account.id} value={account.id}>{account.name}</MenuItem>)}</TextField>
      <TextField select label="Expense account" value={value.expenseAccountId} onChange={field('expenseAccountId')} sx={fieldSx}><MenuItem value="">None</MenuItem>{expenseAccounts.map((account) => <MenuItem key={account.id} value={account.id}>{account.name}</MenuItem>)}</TextField>
      <FormControlLabel control={<Checkbox checked={value.taxable} onChange={(event) => onChange({ ...value, taxable: event.target.checked })} />} label="Taxable" />
    </Stack>
  )
}

function InvoiceForm({ value, onChange, lines, onLinesChange, customers, items, total, money }: {
  value: InvoiceFormValue
  onChange: (value: InvoiceFormValue) => void
  lines: InvoiceLine[]
  onLinesChange: (value: InvoiceLine[]) => void
  customers: ReferenceData['customers']
  items: ReferenceData['items']
  total: number
  money: (value: number) => string
}) {
  const field = (key: keyof InvoiceFormValue) => (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: event.target.value })
  const updateLine = (key: string, patch: Partial<InvoiceLine>) => onLinesChange(lines.map((line) => line.key === key ? { ...line, ...patch } : line))
  return (
    <Stack spacing={2}>
      <TextField select required label="Customer" value={value.customerId} onChange={(event) => {
        const selected = customers.find((customer) => customer.id === event.target.value)
        onChange({ ...value, customerId: event.target.value, billingEmail: selected?.email || value.billingEmail })
      }} sx={fieldSx}>{customers.map((customer) => <MenuItem key={customer.id} value={customer.id}>{customer.displayName}{customer.companyName && customer.companyName !== customer.displayName ? ` · ${customer.companyName}` : ''}</MenuItem>)}</TextField>
      <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1.5}><TextField required type="date" label="Invoice date" value={value.transactionDate} onChange={field('transactionDate')} InputLabelProps={{ shrink: true }} sx={fieldSx} /><TextField type="date" label="Due date" value={value.dueDate} onChange={field('dueDate')} InputLabelProps={{ shrink: true }} sx={fieldSx} /></Box>
      <TextField type="email" label="Billing email" value={value.billingEmail} onChange={field('billingEmail')} sx={fieldSx} />
      <TextField label="Customer memo" multiline minRows={2} value={value.customerMemo} onChange={field('customerMemo')} sx={fieldSx} />
      <Box display="flex" alignItems="center" justifyContent="space-between"><Typography fontWeight={700}>Line items</Typography><Button size="small" startIcon={<AddRounded />} onClick={() => onLinesChange([...lines, newLine()])}>Add line</Button></Box>
      {lines.map((line, index) => (
        <Box key={line.key} sx={{ borderTop: index ? '1px solid rgba(255,255,255,0.08)' : 0, pt: index ? 2 : 0 }}>
          <Box display="flex" alignItems="center" gap={1}>
            <TextField select required fullWidth label={`Item ${index + 1}`} value={line.itemId} onChange={(event) => {
              const selected = items.find((item) => item.id === event.target.value)
              updateLine(line.key, { itemId: event.target.value, unitPrice: String(selected?.unitPrice ?? ''), description: selected?.description || '' })
            }} sx={fieldSx}>{items.map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.name}</MenuItem>)}</TextField>
            <Tooltip title="Remove line"><span><IconButton aria-label={`Remove invoice line ${index + 1}`} disabled={lines.length === 1} onClick={() => onLinesChange(lines.filter((candidate) => candidate.key !== line.key))}><DeleteOutlineRounded /></IconButton></span></Tooltip>
          </Box>
          <TextField fullWidth label="Description" value={line.description} onChange={(event) => updateLine(line.key, { description: event.target.value })} sx={{ ...fieldSx, mt: 1.5 }} />
          <Box display="grid" gridTemplateColumns="1fr 1fr auto" gap={1.5} alignItems="center" mt={1.5}>
            <TextField required type="number" label="Quantity" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} inputProps={{ min: 0.000001, step: '0.01' }} sx={fieldSx} />
            <TextField required type="number" label="Unit price" value={line.unitPrice} onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })} inputProps={{ min: 0, step: '0.01' }} sx={fieldSx} />
            <Typography fontWeight={650} minWidth={84} textAlign="right">{money(Number(line.quantity || 0) * Number(line.unitPrice || 0))}</Typography>
          </Box>
        </Box>
      ))}
      <Box display="flex" justifyContent="space-between" borderTop="1px solid rgba(255,255,255,0.1)" pt={2}><Typography variant="h6" fontWeight={700}>Total</Typography><Typography variant="h6" fontWeight={700}>{money(total)}</Typography></Box>
    </Stack>
  )
}
