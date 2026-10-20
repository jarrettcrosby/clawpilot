'use client'

import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material'
import EventRounded from '@mui/icons-material/EventRounded'

type ImportSource = {
  id: string; calendarId: string; connectionId: string; accountEmail: string
  enabled: boolean; lastPolledAt: string | null; lastError: string | null
}
type CalendarOption = { connectionId: string; calendarId: string; label: string }
type Payload = {
  ok?: boolean; error?: string; sources?: ImportSource[]
  connections?: Array<{ connectionId: string; accountEmail?: string; selectionError?: string
    calendars?: Array<{ id: string; summary: string }> }>
}

export default function CalendarImportSettings({ pipelineId }: { pipelineId: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sources, setSources] = useState<ImportSource[]>([])
  const [options, setOptions] = useState<CalendarOption[]>([])
  const [choice, setChoice] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const activeRequest = useRef<AbortController | null>(null)
  useEffect(() => () => { activeRequest.current?.abort() }, [])

  async function showSettings() {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setOpen(true); setBusy(true); setError(''); setNotice(''); setChoice('')
    setSources([]); setOptions([])
    try {
      const response = await fetch(`/api/crm/calendar-import?pipelineId=${encodeURIComponent(pipelineId)}`,
        { cache: 'no-store', signal: controller.signal })
      const body = await response.json() as Payload
      if (!response.ok || !body.ok) throw new Error(body.error || 'Calendar imports could not be loaded')
      if (controller.signal.aborted) return
      setSources(body.sources || [])
      setOptions((body.connections || []).flatMap((connection) => (connection.calendars || []).map((calendar) => ({
        connectionId: connection.connectionId, calendarId: calendar.id,
        label: `${connection.accountEmail || 'Google Calendar'} — ${calendar.summary || calendar.id}`,
      }))))
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Calendar imports could not be loaded')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }

  async function save(selected: { connectionId: string; calendarId: string }, enabled: boolean) {
    setBusy(true); setError(''); setNotice('')
    const controller = new AbortController()
    activeRequest.current = controller
    try {
      const response = await fetch('/api/crm/calendar-import', { method: 'PUT', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineId, ...selected, enabled }) })
      const body = await response.json() as Payload
      if (!response.ok || !body.ok) throw new Error(body.error || 'Calendar import settings could not be saved')
      if (controller.signal.aborted) return
      setSources(body.sources || [])
      setChoice('')
      setNotice(enabled ? 'Calendar import enabled. Matching meetings will populate during the next sync.'
        : 'Calendar import paused. Existing CRM meetings are retained.')
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Calendar import settings could not be saved')
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }

  const selected = options.find((option) => JSON.stringify([option.connectionId, option.calendarId]) === choice)
  return <>
    <Button size="small" startIcon={<EventRounded />} onClick={() => { void showSettings() }}>Calendar import</Button>
    <Dialog open={open} onClose={() => { if (!busy) setOpen(false) }} fullWidth maxWidth="sm">
      <DialogTitle>Import calendar meetings</DialogTitle>
      <DialogContent>
        <Stack gap={2} sx={{ pt: 1 }}>
          <Alert severity="info">Choose the calendar for this pipeline. Meetings are linked only when attendee emails match CRM contacts on one account. Import does not send invitations.</Alert>
          <Typography variant="body2" color="text.secondary">The initial import covers the last 30 days and next 90 days. Changes and cancellations to imported meetings stay synchronized. Other calendars are not imported.</Typography>
          {error && <Alert severity="error">{error}</Alert>}
          {notice && <Alert severity="success">{notice}</Alert>}
          {busy && <CircularProgress size={22} aria-label="Loading calendar import settings" />}
          {sources.map((item) => <Stack key={item.id} gap={0.5} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{item.calendarId}</Typography>
            <Stack direction="row" gap={1} alignItems="center" justifyContent="space-between">
              <Chip size="small" label={item.enabled ? 'Import enabled' : 'Import paused'} color={item.enabled ? 'success' : 'default'} />
              <Button disabled={busy} onClick={() => { void save({ connectionId: item.connectionId, calendarId: item.calendarId }, !item.enabled) }}>
                {item.enabled ? 'Pause import' : 'Resume import'}
              </Button>
            </Stack>
            {item.lastPolledAt && <Typography variant="caption" color="text.secondary">Last checked: {new Date(item.lastPolledAt).toLocaleString()}</Typography>}
            {item.lastError && <Alert severity="warning">{item.lastError}</Alert>}
          </Stack>)}
          <TextField select label="Linked account and calendar" value={choice} disabled={busy} onChange={(event) => setChoice(event.target.value)} fullWidth>
            <MenuItem value="">Select a calendar</MenuItem>
            {options.map((option) => <MenuItem key={JSON.stringify([option.connectionId, option.calendarId])}
              value={JSON.stringify([option.connectionId, option.calendarId])}>{option.label}</MenuItem>)}
          </TextField>
          {!busy && !options.length && <Alert severity="warning">Connect Google Calendar in Settings → Integrations before enabling imports.</Alert>}
          <Button variant="contained" disabled={busy || !selected} onClick={() => { if (selected) void save({ connectionId: selected.connectionId, calendarId: selected.calendarId }, true) }}>Enable calendar import</Button>
        </Stack>
      </DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>
}
