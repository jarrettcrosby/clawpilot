'use client'

import { FormEvent, useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import InventoryRounded from '@mui/icons-material/InventoryRounded'
import MoveToInboxRounded from '@mui/icons-material/MoveToInboxRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import type {
  OperationsInboundReceiptCommandResult,
  OperationsInboundReceiptCreationResult,
  OperationsWorkspace,
} from '@/lib/operations/types'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type Props = {
  workspace: OperationsWorkspace | null
  onRefresh: () => Promise<void>
}

type Receipt = OperationsWorkspace['inboundReceipts'][number]
type ReceiptLine = Receipt['lines'][number]

type DraftLine = {
  key: string
  productGlobalId: string
  targetLocationGlobalId: string
  expectedQuantity: string
  lotCode: string
  unitOfMeasure: string
}

type CompletionLine = {
  lineGlobalId: string
  acceptedQuantity: string
  damagedQuantity: string
}

type OperationsResponse = {
  ok?: boolean
  error?: string
  result?: OperationsInboundReceiptCreationResult | OperationsInboundReceiptCommandResult
}

const newLine = (): DraftLine => ({
  key: crypto.randomUUID(),
  productGlobalId: '',
  targetLocationGlobalId: '',
  expectedQuantity: '1',
  lotCode: '',
  unitOfMeasure: 'each',
})

function statusColor(status: Receipt['status']): 'default' | 'info' | 'success' | 'warning' {
  if (status === 'completed') return 'success'
  if (status === 'receiving') return 'warning'
  if (status === 'expected') return 'info'
  return 'default'
}

function quantity(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export default function ReceivingPanel({ workspace, onRefresh }: Props) {
  const dateTime = useUserDateTime()
  const [createOpen, setCreateOpen] = useState(false)
  const [warehouseGlobalId, setWarehouseGlobalId] = useState('')
  const [inventoryPoolGlobalId, setInventoryPoolGlobalId] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [expectedAt, setExpectedAt] = useState('')
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()])
  const [creating, setCreating] = useState(false)
  const [creationResult, setCreationResult] = useState<OperationsInboundReceiptCreationResult | null>(null)
  const [completionReceipt, setCompletionReceipt] = useState<Receipt | null>(null)
  const [completionLines, setCompletionLines] = useState<CompletionLine[]>([])
  const [completionReason, setCompletionReason] = useState('Counted and inspected at receiving')
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const activeWarehouses = useMemo(
    () => (workspace?.warehouses || []).filter((warehouse) => warehouse.status === 'active'),
    [workspace],
  )
  const activePools = useMemo(
    () => (workspace?.inventoryPools || []).filter((pool) => pool.active),
    [workspace],
  )
  const selectedWarehouse = activeWarehouses.find(
    (warehouse) => warehouse.globalId === warehouseGlobalId,
  )
  const selectableLocations = useMemo(() => {
    if (!selectedWarehouse) return []
    const activeParentIds = new Set(
      selectedWarehouse.locations
        .filter((location) => location.active && location.parentLocationGlobalId)
        .map((location) => location.parentLocationGlobalId),
    )
    return selectedWarehouse.locations
      .filter((location) => (
        location.active
        && ['storage', 'pick'].includes(location.locationType)
        && !activeParentIds.has(location.globalId)
      ))
      .sort((left, right) => (
        left.pickSequence - right.pickSequence || left.code.localeCompare(right.code)
      ))
  }, [selectedWarehouse])

  const canCreate = Boolean(
    workspace?.capabilities.canManage
    && workspace.capabilities.canExecute
    && activeWarehouses.length
    && activePools.length
    && workspace.catalog.products.length,
  )

  const resetCreate = () => {
    setWarehouseGlobalId(activeWarehouses[0]?.globalId || '')
    setInventoryPoolGlobalId(activePools[0]?.globalId || '')
    setReferenceNumber('')
    setExpectedAt('')
    setLines([newLine()])
    setCreationResult(null)
    setError('')
  }

  const openCreate = () => {
    resetCreate()
    setCreateOpen(true)
  }

  const closeCreate = () => {
    if (creating) return
    setCreateOpen(false)
    setCreationResult(null)
  }

  const updateLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line))
  }

  const createReceipt = async (event: FormEvent) => {
    event.preventDefault()
    if (!warehouseGlobalId || !inventoryPoolGlobalId || !referenceNumber.trim()) return
    setCreating(true)
    setError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `operations-receipt-create:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          action: 'create-inbound-receipt',
          warehouseGlobalId,
          inventoryPoolGlobalId,
          referenceNumber: referenceNumber.trim(),
          expectedAt: expectedAt ? new Date(expectedAt).toISOString() : null,
          lines: lines.map((line) => ({
            productGlobalId: line.productGlobalId,
            targetLocationGlobalId: line.targetLocationGlobalId || null,
            expectedQuantity: quantity(line.expectedQuantity),
            lotCode: line.lotCode.trim(),
            unitOfMeasure: line.unitOfMeasure,
          })),
        }),
      })
      const payload = await response.json() as OperationsResponse
      if (!response.ok || !payload.result || !('placements' in payload.result)) {
        throw new Error(payload.error || 'Inbound receipt could not be created')
      }
      setCreationResult(payload.result)
      setNotice(`Receipt ${payload.result.receiptGlobalId} is ready for receiving.`)
      await onRefresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Inbound receipt could not be created')
    } finally {
      setCreating(false)
    }
  }

  const openCompletion = (receipt: Receipt) => {
    setCompletionReceipt(receipt)
    setCompletionLines(receipt.lines.map((line) => ({
      lineGlobalId: line.globalId,
      acceptedQuantity: String(
        Math.max(0, line.expectedQuantity - line.acceptedQuantity - line.damagedQuantity),
      ),
      damagedQuantity: '0',
    })))
    setCompletionReason('Counted and inspected at receiving')
    setError('')
  }

  const closeCompletion = () => {
    if (completing) return
    setCompletionReceipt(null)
    setCompletionLines([])
  }

  const updateCompletionLine = (lineGlobalId: string, patch: Partial<CompletionLine>) => {
    setCompletionLines((current) => current.map((line) => (
      line.lineGlobalId === lineGlobalId ? { ...line, ...patch } : line
    )))
  }

  const completeReceipt = async (event: FormEvent) => {
    event.preventDefault()
    if (!completionReceipt || !completionReason.trim()) return
    setCompleting(true)
    setError('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `operations-receipt-complete:${completionReceipt.globalId}:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          action: 'complete-inbound-receipt',
          receiptGlobalId: completionReceipt.globalId,
          expectedRowVersion: completionReceipt.rowVersion,
          reason: completionReason.trim(),
          lines: completionLines.map((line) => ({
            lineGlobalId: line.lineGlobalId,
            acceptedQuantity: quantity(line.acceptedQuantity),
            damagedQuantity: quantity(line.damagedQuantity),
          })),
        }),
      })
      const payload = await response.json() as OperationsResponse
      if (!response.ok || !payload.result || !('positionGlobalIds' in payload.result)) {
        throw new Error(payload.error || 'Inbound receipt could not be completed')
      }
      setNotice(
        `Receipt ${payload.result.receiptGlobalId} completed: `
        + `${payload.result.receivedQuantity} accepted, ${payload.result.damagedQuantity} damaged.`,
      )
      closeCompletion()
      await onRefresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Inbound receipt could not be completed')
    } finally {
      setCompleting(false)
    }
  }

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: 2.5, maxWidth: 1280, mx: 'auto' }}>
      <Stack spacing={2.5}>
        {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
        <Alert severity="info">
          Automatic putaway considers product restrictions and preferred bins first, then existing
          product placement and remaining volume or weight capacity. Pick route order is used only
          as the final tie-breaker among eligible locations; it is not customer or order priority.
        </Alert>

        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
          <Box>
            <Typography variant="h6" fontWeight={700}>Inbound receipts</Typography>
            <Typography variant="body2" color="text.secondary">
              Plan expected inventory, inspect quantities, and post accepted and damaged units to
              the inventory ledger.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Tooltip title="Refresh receipts">
              <IconButton aria-label="Refresh inbound receipts" onClick={() => void onRefresh()}>
                <RefreshRounded />
              </IconButton>
            </Tooltip>
            <Tooltip title={canCreate ? 'Create an expected inbound receipt' : 'Configure an active warehouse, inventory pool, and product catalog first'}>
              <span>
                <Button
                  variant="contained"
                  startIcon={<AddRounded />}
                  disabled={!canCreate}
                  onClick={openCreate}
                >
                  New receipt
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </Stack>

        {!workspace?.inboundReceipts?.length ? (
          <Box sx={{ py: 7, textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <MoveToInboxRounded sx={{ fontSize: 38, color: 'text.disabled' }} />
            <Typography sx={{ mt: 1 }} fontWeight={700}>No inbound receipts</Typography>
            <Typography variant="body2" color="text.secondary">
              Create a receipt to plan putaway before product arrives.
            </Typography>
          </Box>
        ) : (
          <Stack divider={<Divider flexItem />}>
            {(workspace.inboundReceipts || []).map((receipt) => (
              <Box key={receipt.globalId} sx={{ py: 2 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.5}>
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      <Typography fontWeight={700}>{receipt.referenceNumber}</Typography>
                      <Chip size="small" label={receipt.status} color={statusColor(receipt.status)} />
                      <Chip size="small" variant="outlined" label={receipt.globalId} />
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {receipt.warehouseName} · {receipt.inventoryPoolName}
                      {receipt.expectedAt
                        ? ` · Expected ${formatUserDateTime(receipt.expectedAt, dateTime)}`
                        : ''}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2">
                      {receipt.receivedQuantity}/{receipt.expectedQuantity} accepted
                      {receipt.damagedQuantity ? ` · ${receipt.damagedQuantity} damaged` : ''}
                    </Typography>
                    {['expected', 'receiving'].includes(receipt.status) && (
                      <Button
                        variant="outlined"
                        startIcon={<CheckCircleRounded />}
                        disabled={!workspace.capabilities.canManage || !workspace.capabilities.canExecute}
                        onClick={() => openCompletion(receipt)}
                      >
                        Receive
                      </Button>
                    )}
                  </Stack>
                </Stack>
                <Stack spacing={0.75} sx={{ mt: 1.5 }}>
                  {receipt.lines.map((line) => (
                    <Stack
                      key={line.globalId}
                      direction={{ xs: 'column', sm: 'row' }}
                      justifyContent="space-between"
                      gap={0.5}
                    >
                      <Typography variant="body2">
                        {line.productName}
                        {line.productSku ? ` · ${line.productSku}` : ''}
                        {line.lotCode ? ` · Lot ${line.lotCode}` : ''}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {line.expectedQuantity} {line.unitOfMeasure} → {line.targetLocationCode}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </Box>
            ))}
          </Stack>
        )}
      </Stack>

      <Dialog open={createOpen} onClose={closeCreate} fullWidth maxWidth="md">
        <Box component="form" onSubmit={createReceipt}>
          <DialogTitle>New inbound receipt</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2.25}>
              {error && <Alert severity="error">{error}</Alert>}
              {creationResult ? (
                <>
                  <Alert severity="success">
                    {creationResult.receiptGlobalId} was created with
                    {' '}{creationResult.expectedQuantity} expected units.
                  </Alert>
                  <Box>
                    <Typography fontWeight={700}>Putaway plan</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Revalidated against current inventory and capacity when receiving is completed.
                    </Typography>
                  </Box>
                  <Stack divider={<Divider flexItem />}>
                    {creationResult.placements.map((placement) => (
                      <Box key={placement.lineGlobalId} sx={{ py: 1.25 }}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          <Chip size="small" icon={<InventoryRounded />} label={placement.targetLocationCode} />
                          <Chip size="small" variant="outlined" label={placement.strategy.replaceAll('_', ' ')} />
                        </Stack>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                          {placement.explanation}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                </>
              ) : (
                <>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField
                      select
                      required
                      fullWidth
                      label="Warehouse"
                      value={warehouseGlobalId}
                      onChange={(event) => {
                        setWarehouseGlobalId(event.target.value)
                        setLines((current) => current.map((line) => ({
                          ...line,
                          targetLocationGlobalId: '',
                        })))
                      }}
                    >
                      {activeWarehouses.map((warehouse) => (
                        <MenuItem key={warehouse.globalId} value={warehouse.globalId}>
                          {warehouse.name} · {warehouse.code}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      select
                      required
                      fullWidth
                      label="Inventory ownership pool"
                      value={inventoryPoolGlobalId}
                      onChange={(event) => setInventoryPoolGlobalId(event.target.value)}
                    >
                      {activePools.map((pool) => (
                        <MenuItem key={pool.globalId} value={pool.globalId}>
                          {pool.name}{pool.ownerCustomerName ? ` · ${pool.ownerCustomerName}` : ''}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Stack>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField
                      required
                      fullWidth
                      label="Receipt reference"
                      value={referenceNumber}
                      onChange={(event) => setReferenceNumber(event.target.value)}
                      helperText="Purchase order, ASN, transfer, or other unique inbound reference"
                    />
                    <TextField
                      fullWidth
                      type="datetime-local"
                      label="Expected arrival"
                      value={expectedAt}
                      onChange={(event) => setExpectedAt(event.target.value)}
                      InputLabelProps={{ shrink: true }}
                    />
                  </Stack>
                  <Divider />
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Box>
                      <Typography fontWeight={700}>Products</Typography>
                      <Typography variant="body2" color="text.secondary">
                        One receipt may contain multiple products and lots.
                      </Typography>
                    </Box>
                    <Button
                      startIcon={<AddRounded />}
                      onClick={() => setLines((current) => [...current, newLine()])}
                    >
                      Add line
                    </Button>
                  </Stack>
                  <Stack spacing={2} divider={<Divider flexItem />}>
                    {lines.map((line, index) => (
                      <Box key={line.key} sx={{ pt: 0.5 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                          <Typography fontWeight={700}>Line {index + 1}</Typography>
                          <Tooltip title="Remove line">
                            <span>
                              <IconButton
                                size="small"
                                aria-label={`Remove receipt line ${index + 1}`}
                                disabled={lines.length === 1}
                                onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}
                              >
                                <DeleteOutlineRounded />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                        <Stack spacing={1.5}>
                          <Autocomplete
                            options={workspace?.catalog.products || []}
                            getOptionLabel={(option) => `${option.name}${option.sku ? ` · ${option.sku}` : ''}`}
                            value={workspace?.catalog.products.find(
                              (product) => product.globalId === line.productGlobalId,
                            ) || null}
                            onChange={(_, product) => updateLine(line.key, {
                              productGlobalId: product?.globalId || '',
                            })}
                            renderInput={(params) => (
                              <TextField {...params} required label="Product" />
                            )}
                          />
                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                            <TextField
                              required
                              fullWidth
                              type="number"
                              label="Expected quantity"
                              inputProps={{ min: 0.000001, step: 'any' }}
                              value={line.expectedQuantity}
                              onChange={(event) => updateLine(line.key, {
                                expectedQuantity: event.target.value,
                              })}
                            />
                            <TextField
                              fullWidth
                              label="Inventory unit"
                              value="Each"
                              helperText="Canonical units; case and pallet conversion require a versioned UOM profile."
                              slotProps={{ input: { readOnly: true } }}
                            />
                            <TextField
                              fullWidth
                              label="Lot (optional)"
                              value={line.lotCode}
                              onChange={(event) => updateLine(line.key, {
                                lotCode: event.target.value,
                              })}
                            />
                          </Stack>
                          <TextField
                            select
                            fullWidth
                            label="Putaway destination"
                            value={line.targetLocationGlobalId}
                            onChange={(event) => updateLine(line.key, {
                              targetLocationGlobalId: event.target.value,
                            })}
                            helperText="Automatic placement is recommended and records why the destination was selected."
                          >
                            <MenuItem value="">Automatic putaway</MenuItem>
                            {selectableLocations.map((location) => (
                              <MenuItem key={location.globalId} value={location.globalId}>
                                {location.code} · {location.locationType} · route {location.pickSequence}
                              </MenuItem>
                            ))}
                          </TextField>
                        </Stack>
                      </Box>
                    ))}
                  </Stack>
                </>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeCreate} disabled={creating}>
              {creationResult ? 'Done' : 'Cancel'}
            </Button>
            {!creationResult && (
              <Button
                type="submit"
                variant="contained"
                disabled={
                  creating
                  || !warehouseGlobalId
                  || !inventoryPoolGlobalId
                  || !referenceNumber.trim()
                  || lines.some((line) => !line.productGlobalId || quantity(line.expectedQuantity) <= 0)
                }
              >
                {creating ? 'Planning…' : 'Create and plan putaway'}
              </Button>
            )}
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={Boolean(completionReceipt)} onClose={closeCompletion} fullWidth maxWidth="md">
        <Box component="form" onSubmit={completeReceipt}>
          <DialogTitle>Receive {completionReceipt?.referenceNumber}</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              {error && <Alert severity="error">{error}</Alert>}
              <Alert severity="warning">
                Completion writes immutable inventory ledger events. Enter damaged product
                separately. Every expected unit must be classified as accepted or damaged.
              </Alert>
              {completionReceipt?.lines.map((line: ReceiptLine) => {
                const completion = completionLines.find((item) => item.lineGlobalId === line.globalId)
                return (
                  <Box key={line.globalId}>
                    <Typography fontWeight={700}>
                      {line.productName} → {line.targetLocationCode}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Expected {line.expectedQuantity} {line.unitOfMeasure}
                    </Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                      <TextField
                        required
                        fullWidth
                        type="number"
                        label="Accepted"
                        inputProps={{ min: 0, max: line.expectedQuantity, step: 'any' }}
                        value={completion?.acceptedQuantity || '0'}
                        onChange={(event) => updateCompletionLine(line.globalId, {
                          acceptedQuantity: event.target.value,
                        })}
                      />
                      <TextField
                        required
                        fullWidth
                        type="number"
                        label="Damaged"
                        inputProps={{ min: 0, max: line.expectedQuantity, step: 'any' }}
                        value={completion?.damagedQuantity || '0'}
                        onChange={(event) => updateCompletionLine(line.globalId, {
                          damagedQuantity: event.target.value,
                        })}
                      />
                    </Stack>
                  </Box>
                )
              })}
              <TextField
                required
                fullWidth
                multiline
                minRows={2}
                label="Receiving reason"
                value={completionReason}
                onChange={(event) => setCompletionReason(event.target.value)}
                helperText="Stored with the audit event and every inventory ledger entry."
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeCompletion} disabled={completing}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                completing
                || !completionReason.trim()
                || completionLines.some((line) => {
                  const receiptLine = completionReceipt?.lines.find(
                    (receiptItem) => receiptItem.globalId === line.lineGlobalId,
                  )
                  return quantity(line.acceptedQuantity) < 0
                    || quantity(line.damagedQuantity) < 0
                    || !receiptLine
                    || Math.abs(
                      quantity(line.acceptedQuantity)
                      + quantity(line.damagedQuantity)
                      - receiptLine.expectedQuantity,
                    ) > 0.000001
                })
              }
            >
              {completing ? 'Posting…' : 'Complete receiving'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  )
}
