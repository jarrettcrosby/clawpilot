'use client'

import { Fragment, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  parseCustomerFolderLinks,
  segmentCustomerFolderDescription,
  updateCustomerFolderLinks,
  type CustomerFolderLinks,
} from '@/lib/crm/customerFolderLinks'

/** Only validated folder links become anchors; arbitrary description HTML stays text. */
export function CustomerFolderDescription({ description }: { description: string }) {
  return <>{segmentCustomerFolderDescription(description).map((segment, index) => segment.type === 'folder-link'
    ? <Fragment key={index}>{segment.label}: <Link href={segment.url} target="_blank" rel="noopener noreferrer"
      onClick={event => event.stopPropagation()} sx={{ overflowWrap: 'anywhere' }}>{segment.url}</Link>{segment.lineEnding}</Fragment>
    : segment.text)}</>
}

type Props = {
  description: string
  descriptionHash: string
  readOnly: boolean
  disabled?: boolean
  onSave: (description: string, capturedHash: string) => Promise<boolean>
}

export default function CustomerFolderLinksEditor({ description, descriptionHash, readOnly, disabled = false, onSave }: Props) {
  // Capture the exact revision when editing starts. A live card refresh must
  // never pair an older draft with a newer description hash on submission.
  const [baseline, setBaseline] = useState<{ description: string; hash: string } | null>(null)
  const [values, setValues] = useState<CustomerFolderLinks>({ bpoDriveUrl: '', fractionalCustomerFolderUrl: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submitting = useRef(false)

  function begin() {
    if (readOnly || disabled) return
    setBaseline({ description, hash: descriptionHash })
    setValues(parseCustomerFolderLinks(description).values)
    setError('')
  }

  async function save() {
    if (!baseline || readOnly || submitting.current) return
    setError('')
    let next: string
    try { next = updateCustomerFolderLinks(baseline.description, values) }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Check the folder links.')
      return
    }
    if (next === baseline.description) { setBaseline(null); return }
    submitting.current = true
    setSaving(true)
    try {
      const saved = await onSave(next, baseline.hash)
      if (saved) setBaseline(null)
      else setError('The links were not saved. Your entries are preserved. If the CRM description changed, refresh and reopen this editor.')
    } catch {
      setError('The links were not saved. Your entries are preserved; please retry.')
    } finally { submitting.current = false; setSaving(false) }
  }

  if (readOnly) return null
  return <>
    <Button size="small" variant="outlined" disabled={disabled} onClick={begin}
      sx={{ textTransform: 'none', mb: 1 }}>Edit customer folder links</Button>
    <Dialog open={baseline !== null} onClose={() => { if (!saving) setBaseline(null) }} fullWidth maxWidth="sm">
      <DialogTitle>Customer folder links</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            These links belong only to this customer. Saving updates the card and its CRM description, preserving other notes.
          </Typography>
          <TextField label="BPO Supply Chain Drive" type="url" fullWidth value={values.bpoDriveUrl} disabled={saving}
            onChange={event => setValues(current => ({ ...current, bpoDriveUrl: event.target.value }))}
            helperText="Paste the existing folder link you created manually. ClawPilot never creates this folder."
            slotProps={{ htmlInput: { maxLength: 2048 } }} />
          <TextField label="Fractional Customer Folder" type="url" fullWidth value={values.fractionalCustomerFolderUrl} disabled={saving}
            onChange={event => setValues(current => ({ ...current, fractionalCustomerFolderUrl: event.target.value }))}
            helperText="Reference the customer folder created by Fractional. This does not create another folder."
            slotProps={{ htmlInput: { maxLength: 2048 } }} />
          <Typography variant="caption" color="text.secondary">Use HTTPS links. Clearing a field removes that link from this description. Drive access permissions are unchanged.</Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={saving} onClick={() => setBaseline(null)}>Cancel</Button>
        <Button variant="contained" disabled={saving} onClick={() => { void save() }}>{saving ? 'Saving…' : 'Save links'}</Button>
      </DialogActions>
    </Dialog>
  </>
}
