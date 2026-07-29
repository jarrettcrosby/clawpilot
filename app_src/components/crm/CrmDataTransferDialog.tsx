'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
} from '@mui/material'
import UploadFileRounded from '@mui/icons-material/UploadFileRounded'
import DownloadRounded from '@mui/icons-material/DownloadRounded'
import type { CrmEntity } from '@/lib/crm/types'

type TransferClassification =
  | 'create'
  | 'update'
  | 'unchanged'
  | 'ambiguous'
  | 'invalid'

type TransferRow = {
  rowNumber: number
  classification: TransferClassification
  globalId: string
  displayName: string
  diffs: Array<{ field: string; before: string; after: string }>
  errors: Array<{
    rowNumber: number
    column?: string
    code: string
    message: string
  }>
  selected: boolean
}

type TransferPreview = {
  runId: string
  entity: CrmEntity
  expiresAt: string
  summary: Record<TransferClassification | 'total', number>
  rows: TransferRow[]
}

type Payload = {
  ok?: boolean
  error?: string
  preview?: TransferPreview
  result?: {
    applied?: number
    warnings?: string[]
  }
}

type Props = {
  open: boolean
  entity: CrmEntity
  onClose: () => void
  onApplied: (count: number, warnings: string[]) => Promise<void> | void
}

const CRM_CSV_MAX_BYTES = 1_048_576

const CLASSIFICATION_COLORS: Record<
  TransferClassification,
  'success' | 'warning' | 'error' | 'default' | 'info'
> = {
  create: 'success',
  update: 'warning',
  unchanged: 'default',
  ambiguous: 'warning',
  invalid: 'error',
}

function quoteCsv(value: unknown) {
  const raw = String(value ?? '')
  const hardened = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw
  return `"${hardened.replace(/"/g, '""')}"`
}

export default function CrmDataTransferDialog({
  open,
  entity,
  onClose,
  onApplied,
}: Props) {
  const fullScreen = useMediaQuery('(max-width:699.95px)')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<TransferPreview | null>(null)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [confirmUpdates, setConfirmUpdates] = useState(false)
  const [applyIdempotencyKey, setApplyIdempotencyKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) return
    setFile(null)
    setPreview(null)
    setSelectedRows(new Set())
    setConfirmUpdates(false)
    setApplyIdempotencyKey('')
    setError('')
  }, [open])

  const selectedUpdateCount = useMemo(() => {
    if (!preview) return 0
    return preview.rows.filter((row) => (
      row.classification === 'update' && selectedRows.has(row.rowNumber)
    )).length
  }, [preview, selectedRows])

  async function createPreview() {
    if (!file) return
    if (file.size > CRM_CSV_MAX_BYTES) {
      setError('CRM CSV uploads are limited to 1 MB')
      return
    }
    setBusy(true)
    setError('')
    try {
      const form = new FormData()
      form.set('entity', entity)
      form.set('file', file)
      const response = await fetch('/api/crm/data-transfer', {
        method: 'POST',
        body: form,
      })
      const payload = await response.json().catch(() => ({})) as Payload
      if (!response.ok || !payload.ok || !payload.preview) {
        throw new Error(payload.error || 'Unable to preview CRM import')
      }
      setPreview(payload.preview)
      setSelectedRows(new Set(payload.preview.rows
        .filter((row) => row.classification === 'create')
        .map((row) => row.rowNumber)))
      setConfirmUpdates(false)
      setApplyIdempotencyKey(crypto.randomUUID())
    } catch (previewError) {
      setError(previewError instanceof Error
        ? previewError.message
        : 'Unable to preview CRM import')
    } finally {
      setBusy(false)
    }
  }

  async function applyPreview() {
    if (!preview || selectedRows.size === 0) return
    setBusy(true)
    setError('')
    try {
      const idempotencyKey = applyIdempotencyKey || crypto.randomUUID()
      if (!applyIdempotencyKey) setApplyIdempotencyKey(idempotencyKey)
      const response = await fetch('/api/crm/data-transfer', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          runId: preview.runId,
          rowNumbers: [...selectedRows],
          confirmUpdates,
        }),
      })
      const payload = await response.json().catch(() => ({})) as Payload
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Unable to apply CRM import')
      }
      await onApplied(
        Number(payload.result?.applied) || 0,
        payload.result?.warnings || [],
      )
      onClose()
    } catch (applyError) {
      setError(applyError instanceof Error
        ? applyError.message
        : 'Unable to apply CRM import')
    } finally {
      setBusy(false)
    }
  }

  function toggleRow(row: TransferRow) {
    if (row.classification !== 'create' && row.classification !== 'update') return
    setSelectedRows((current) => {
      const next = new Set(current)
      if (next.has(row.rowNumber)) next.delete(row.rowNumber)
      else next.add(row.rowNumber)
      return next
    })
  }

  function downloadErrors() {
    if (!preview) return
    const rows = preview.rows.flatMap((row) => row.errors.map((item) => [
      row.rowNumber,
      item.column || '',
      item.code,
      item.message,
      row.globalId,
    ]))
    if (rows.length === 0) return
    const csv = [
      ['row', 'column', 'code', 'message', 'global_id'],
      ...rows,
    ].map((row) => row.map(quoteCsv).join(',')).join('\r\n').concat('\r\n')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([csv], {
      type: 'text/csv;charset=utf-8',
    }))
    link.download = `clawpilot-${entity}-import-errors.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose() }}
      fullWidth
      fullScreen={fullScreen}
      maxWidth="lg"
      aria-labelledby="crm-data-transfer-title"
    >
      <DialogTitle id="crm-data-transfer-title">
        Import {entity}
      </DialogTitle>
      <DialogContent dividers>
        <Stack gap={2}>
          <Alert severity="info">
            Export this CRM tab first, edit that CSV, then preview it here.
            Blank Global IDs create records. Existing Global IDs can only update
            the record and revision included in the export.
          </Alert>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            gap={1}
            alignItems={{ sm: 'center' }}
          >
            <Button
              component="a"
              href={`/api/crm/data-transfer?entity=${encodeURIComponent(entity)}&template=true`}
              variant="text"
              startIcon={<DownloadRounded />}
            >
              Download template
            </Button>
            <Button component="label" variant="outlined" startIcon={<UploadFileRounded />}>
              Choose CSV
              <input
                hidden
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const selected = event.target.files?.[0] || null
                  if (selected && selected.size > CRM_CSV_MAX_BYTES) {
                    setFile(null)
                    setError('CRM CSV uploads are limited to 1 MB')
                    event.target.value = ''
                  } else {
                    setFile(selected)
                    setError('')
                  }
                  setPreview(null)
                  setSelectedRows(new Set())
                  setConfirmUpdates(false)
                  setApplyIdempotencyKey('')
                }}
              />
            </Button>
            <Typography variant="body2" color="text.secondary">
              {file?.name || 'No file selected'}
            </Typography>
            <Button
              variant="contained"
              disabled={!file || busy}
              onClick={() => { void createPreview() }}
            >
              {busy && !preview ? 'Checking…' : 'Preview changes'}
            </Button>
          </Stack>

          {preview && (
            <>
              <Stack direction="row" gap={1} flexWrap="wrap">
                <Chip label={`${preview.summary.create} create`} color="success" variant="outlined" />
                <Chip label={`${preview.summary.update} update`} color="warning" variant="outlined" />
                <Chip label={`${preview.summary.unchanged} unchanged`} variant="outlined" />
                <Chip label={`${preview.summary.ambiguous} ambiguous`} color="warning" variant="outlined" />
                <Chip label={`${preview.summary.invalid} invalid`} color="error" variant="outlined" />
              </Stack>
              {preview.summary.update > 0 && (
                <Alert severity="warning">
                  Existing records are not selected automatically. Review each
                  field-level change before selecting an update.
                </Alert>
              )}
              <TableContainer sx={{ maxHeight: 440, border: 1, borderColor: 'divider' }}>
                <Table stickyHeader size="small" aria-label="CRM import preview">
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">Apply</TableCell>
                      <TableCell>Row</TableCell>
                      <TableCell>Result</TableCell>
                      <TableCell>Record</TableCell>
                      <TableCell>Changes or errors</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {preview.rows.map((row) => (
                      <TableRow key={row.rowNumber}>
                        <TableCell padding="checkbox">
                          <Checkbox
                            checked={selectedRows.has(row.rowNumber)}
                            disabled={row.classification !== 'create'
                              && row.classification !== 'update'}
                            onChange={() => toggleRow(row)}
                            inputProps={{ 'aria-label': `Apply CSV row ${row.rowNumber}` }}
                          />
                        </TableCell>
                        <TableCell>{row.rowNumber}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={row.classification}
                            color={CLASSIFICATION_COLORS[row.classification]}
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>
                            {row.displayName || 'Unnamed record'}
                          </Typography>
                          {row.globalId && (
                            <Typography variant="caption" color="text.secondary">
                              {row.globalId}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Stack gap={0.5}>
                            {row.diffs.map((diff) => (
                              <Box key={diff.field}>
                                <Typography variant="caption" fontWeight={700}>
                                  {diff.field.replaceAll('_', ' ')}
                                </Typography>
                                <Typography variant="caption" display="block" color="text.secondary">
                                  {diff.before || 'blank'} → {diff.after || 'blank'}
                                </Typography>
                              </Box>
                            ))}
                            {row.errors.map((item, index) => (
                              <Typography
                                key={`${item.code}-${index}`}
                                variant="caption"
                                color="error"
                              >
                                {item.column ? `${item.column}: ` : ''}{item.message}
                              </Typography>
                            ))}
                            {row.classification === 'unchanged' && (
                              <Typography variant="caption" color="text.secondary">
                                No field changes
                              </Typography>
                            )}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              {(preview.summary.invalid > 0 || preview.summary.ambiguous > 0) && (
                <Button
                  startIcon={<DownloadRounded />}
                  variant="text"
                  sx={{ alignSelf: 'flex-start' }}
                  onClick={downloadErrors}
                >
                  Download error report
                </Button>
              )}
              {selectedUpdateCount > 0 && (
                <FormControlLabel
                  control={(
                    <Checkbox
                      checked={confirmUpdates}
                      onChange={(event) => setConfirmUpdates(event.target.checked)}
                    />
                  )}
                  label={`I reviewed ${selectedUpdateCount} change${selectedUpdateCount === 1 ? '' : 's'} to existing records`}
                />
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        {preview && (
          <Button
            variant="contained"
            disabled={
              busy
              || selectedRows.size === 0
              || (selectedUpdateCount > 0 && !confirmUpdates)
            }
            onClick={() => { void applyPreview() }}
          >
            {busy ? 'Applying…' : `Apply ${selectedRows.size} selected`}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
