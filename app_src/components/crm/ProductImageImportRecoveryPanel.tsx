'use client'

import { Alert, Button, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { useCallback, useEffect, useRef, useState } from 'react'

type Recovery = {
  jobId: string
  jobGlobalId: string
  provider: string
  accountGlobalId: string
  jobGeneration: number
  errorCode: string | null
  attemptCount: number
  maxAttempts: number
  updatedAt: string
  retryEligible: boolean
}

/** Separate from outbound publication: this only queues a reviewed inbound retry. */
export default function ProductImageImportRecoveryPanel({ productId }: { productId: string }) {
  const [jobs, setJobs] = useState<Recovery[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const pending = useRef<{ fingerprint: string; key: string } | null>(null)
  const endpoint = `/api/crm/products/${encodeURIComponent(productId)}/image-import-recovery`
  const selected = jobs.find((job) => job.jobId === selectedId)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not read image recovery status')
      if (signal?.aborted) return
      setJobs(result.jobs || [])
      setHasMore(result.hasMore === true)
      setSelectedId((current) => result.jobs?.some((job: Recovery) => job.jobId === current) ? current : '')
      setError('')
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught.message : 'Could not read image recovery status')
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [endpoint])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function retry() {
    if (!selected?.retryEligible || !selected.errorCode || !confirmed
      || reason.trim().length < 10 || reason.trim().length > 500 || busy) return
    const command = { jobId: selected.jobId, expectedJobGeneration: selected.jobGeneration,
      expectedErrorCode: selected.errorCode, reason: reason.trim(), confirmInboundOnly: true }
    const fingerprint = JSON.stringify(command)
    if (pending.current?.fingerprint !== fingerprint) {
      pending.current = { fingerprint, key: crypto.randomUUID() }
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...command, idempotencyKey: pending.current.key }) })
      const result = await response.json()
      if (!response.ok || !result.ok) throw new Error(result.error || 'Image retry could not be queued')
      setNotice('Inbound image retry queued. The original failure remains in history. No image was published to the sales channel.')
      setConfirmed(false)
      setReason('')
      pending.current = null
      await load()
    } catch (caught) {
      // Keep the same command key after ambiguous network failures.
      setError(caught instanceof Error ? caught.message : 'Image retry could not be queued')
    } finally { setBusy(false) }
  }

  return <Stack spacing={1} data-testid="product-image-import-recovery">
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="subtitle2">Inbound image recovery</Typography>
      <Button size="small" disabled={busy || loading} onClick={() => void load()}>Refresh failures</Button>
    </Stack>
    {error && <Alert severity="warning">{error}</Alert>}
    {notice && <Alert severity="success">{notice}</Alert>}
    {!jobs.length && !loading && !error && <Typography variant="caption" color="text.secondary">
      No current, mapped failed image imports for this product.
    </Typography>}
    {jobs.length > 0 && <>
      <Typography variant="caption" color="text.secondary">
        Review the cause before retrying. One operator retry is allowed per source observation;
        normal worker attempt limits still apply. Only current organization and product evidence is eligible.
      </Typography>
      <TextField select size="small" label="Failed inbound image" value={selectedId}
        disabled={busy} onChange={(event) => { setSelectedId(event.target.value); setConfirmed(false); setReason('') }}>
        {jobs.map((job) => <MenuItem key={job.jobId} value={job.jobId}>
          {job.provider} · {job.jobGlobalId} · {job.errorCode || 'Unknown failure'}
        </MenuItem>)}
      </TextField>
      {selected && <>
        <Typography variant="caption" color="text.secondary">
          Account {selected.accountGlobalId} · Generation {selected.jobGeneration} · Attempts {selected.attemptCount}/{selected.maxAttempts}
        </Typography>
        {!selected.retryEligible ? <Alert severity="info">
          This source observation is not eligible for another retry. Investigate the cause and obtain current source evidence before recovery.
        </Alert> : <>
          <TextField label="Reviewed cause and reason to retry" multiline minRows={2} size="small"
            value={reason} disabled={busy} onChange={(event) => { setReason(event.target.value); setConfirmed(false) }}
            slotProps={{ htmlInput: { maxLength: 500 } }} helperText="10–500 characters. Do not enter credentials or customer data." />
          <FormControlLabel control={<Checkbox checked={confirmed} disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)} />}
            label="I reviewed this failure and approve one inbound image retry. This does not publish images or update provider stock." />
          <Button variant="outlined" disabled={busy || !confirmed || reason.trim().length < 10 || reason.trim().length > 500}
            onClick={() => void retry()}>{busy ? 'Queuing…' : 'Queue reviewed image retry'}</Button>
        </>}
      </>}
      {hasMore && <Typography variant="caption">Showing the latest 25 current failures. Refresh after resolving these to review remaining failures.</Typography>}
    </>}
  </Stack>
}
