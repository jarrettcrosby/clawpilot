'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Autocomplete, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material'
import EmailRounded from '@mui/icons-material/EmailRounded'
import { loadGoogleIdentityServices } from '@/components/settings/GoogleAuthSettingsPanel'

export type EmailReviewCandidate = { messageId: string; threadId: string; subject: string; receivedAt: string
  legacy: boolean; admissionScope?: 'casey-reviewed-two-v1'; participantEmails: string[]
  participantContactIds: string[]; participantContacts: ContactChoice[] }
type Mailbox = { connectionId: string; accountEmail: string; verified: boolean }
type MailboxLabelPreview = { required: boolean; oldAccountEmail: string; newAccountEmail: string; expectedDigest: string; expiresAt: string }
type MailboxLabelProof = { pipelineId: string; connectionId: string; idToken: string; expectedDigest: string; expiresAt: string }
type Selection = { contactIds: string[]; primaryOrganizationReference: string }
type Decision = 'review' | 'correction' | 'late-contact' | 'casey-history'
type ReviewedMessage = { messageId: string; subject: string; organizationReferences: string[]; contactReferences: string[]; alreadyLinked?: boolean }
type Preview = { digest: string; inputKey: string; messages: ReviewedMessage[] }
type ContactChoice = { id: string; reference: string; name: string; email: string; organizationId: string
  organizationReference: string; company: string }

function exactContactChoices(message: EmailReviewCandidate) {
  return (message.participantContacts || []).filter(contact => contact.reference && contact.organizationReference
    && message.participantContactIds.includes(contact.id) && message.participantEmails.includes(contact.email))
}

export function validMailboxLabelPreview(value: unknown, now = Date.now()): value is MailboxLabelPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).sort().join(',') !== 'expectedDigest,expiresAt,newAccountEmail,oldAccountEmail,required') return false
  const preview = value as MailboxLabelPreview
  const email = (address: unknown) => typeof address === 'string' && address.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
  if (typeof preview.oldAccountEmail !== 'string' || preview.oldAccountEmail.length > 254
    || /[\u0000-\u001f\u007f]/.test(preview.oldAccountEmail)
    || (preview.oldAccountEmail.trim() !== '' && !email(preview.oldAccountEmail.trim()))) return false
  if (typeof preview.expiresAt !== 'string' || preview.expiresAt.length > 32) return false
  const expires = Date.parse(preview.expiresAt)
  return typeof preview.required === 'boolean' && email(preview.newAccountEmail)
    && /^[a-f0-9]{64}$/.test(preview.expectedDigest) && Number.isFinite(expires)
    && expires > now && expires <= now + 5 * 60_000 + 30_000
    && preview.required === (preview.oldAccountEmail.trim().toLowerCase() !== preview.newAccountEmail)
}

export function MailboxLabelRepairFields({ preview, busy, onConfirm, onCancel }: {
  preview: MailboxLabelPreview; busy: boolean; onConfirm: () => void; onCancel: () => void
}) {
  return <Stack gap={1.5}>
    <Typography variant="subtitle2">Confirm the connected Gmail address</Typography>
    <Typography sx={{ overflowWrap: 'anywhere' }}>Saved address: {preview.oldAccountEmail.trim() || 'Not recorded'}</Typography>
    <Typography sx={{ overflowWrap: 'anywhere' }}>Verified Google address: {preview.newAccountEmail}</Typography>
    <Alert severity="warning">Update only this connection’s saved address and verified mailbox binding. This does not change your ClawPilot login, reconnect Google, move messages, or verify historical email records.</Alert>
    <Stack direction="row" gap={1} sx={{ flexWrap: 'wrap' }}>
      <Button variant="contained" disabled={busy} onClick={onConfirm}>Confirm address update</Button>
      <Button disabled={busy} onClick={onCancel}>Cancel address review</Button>
    </Stack>
  </Stack>
}

export function emailReviewCommand(input: { pipelineId: string; connectionId: string; decisionKind: Decision
  correctionReason: string; participantEmail: string; candidates: EmailReviewCandidate[]; selections: Record<string, Selection> }) {
  const selected = input.candidates.filter(message => Object.hasOwn(input.selections, message.messageId))
    .sort((a, b) => a.messageId.localeCompare(b.messageId))
  if (!input.connectionId || !selected.length || selected.length > 25
    || (input.decisionKind === 'correction' && (!input.correctionReason.trim() || input.correctionReason.trim().length > 500))
    || (input.decisionKind === 'late-contact' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.participantEmail.trim()))) return null
  const caseyPair = input.decisionKind === 'casey-history'
  if (caseyPair && (selected.length !== 2 || input.candidates.length !== 2
    || new Set(selected.map(message => message.messageId)).size !== 2
    || selected.some(message => !message.legacy || message.admissionScope !== 'casey-reviewed-two-v1'))) return null
  if (!caseyPair && input.candidates.some(message => message.admissionScope !== undefined)) return null
  if (!caseyPair && selected.some(message => message.legacy)
    && (selected.length !== 3 || selected.some(message => !message.legacy)
      || input.candidates.filter(message => message.legacy).length !== 3)) return null
  const associations = selected.map(message => {
    const selection = input.selections[message.messageId]
    const options = exactContactChoices(message)
    const contacts = selection.contactIds.map(id => options.find(contact => contact.id === id))
    const primary = contacts.find(contact => contact?.organizationReference === selection.primaryOrganizationReference)
    if (!contacts.length || contacts.length > 25 || new Set(selection.contactIds).size !== contacts.length
      || !primary || contacts.some(contact => !contact)
      || (input.decisionKind === 'late-contact' && !contacts.some(contact => contact?.email === input.participantEmail.trim().toLowerCase()))) return null
    return { messageId: message.messageId, threadId: message.threadId,
      primaryOrganizationReference: primary.organizationReference,
      contactReferences: contacts.map(contact => contact!.reference).sort() }
  })
  if (associations.some(value => value === null)) return null
  return { pipelineId: input.pipelineId, connectionId: input.connectionId, messageIds: selected.map(message => message.messageId),
    reviewedAssociations: associations, decisionKind: caseyPair ? 'review' : input.decisionKind,
    ...(caseyPair ? { admissionScope: 'casey-reviewed-two-v1' } : {}),
    ...(input.decisionKind === 'correction' ? { correctionReason: input.correctionReason.trim() } : {}),
    ...(input.decisionKind === 'late-contact' ? { participantEmail: input.participantEmail.trim().toLowerCase() } : {}) }
}

export function EmailReviewFields({ candidates, selections, disabled, onSelection }: {
  candidates: EmailReviewCandidate[]; selections: Record<string, Selection>
  disabled: boolean; onSelection: (messageId: string, selection: Selection | null) => void
}) {
  return <Stack gap={2}>
    {candidates.map(message => {
      const selected = selections[message.messageId]
      const options = exactContactChoices(message)
      const chosen = selected ? options.filter(contact => selected.contactIds.includes(contact.id)) : []
      const companies = [...new Map(chosen.map(contact => [contact.organizationId, contact])).values()]
      return <Stack key={message.messageId} gap={1} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
        <FormControlLabel control={<Checkbox checked={Boolean(selected)} disabled={disabled}
          onChange={(_, checked) => onSelection(message.messageId, checked ? { contactIds: [], primaryOrganizationReference: '' } : null)} />}
          label={<Typography sx={{ overflowWrap: 'anywhere' }}>{message.subject}</Typography>} />
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          Message {message.messageId} · {message.receivedAt} · {message.admissionScope === 'casey-reviewed-two-v1'
            ? 'Separate two-message Casey review' : message.legacy ? 'Fixed three-message legacy review' : 'Verified mailbox cache'}
        </Typography>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>Actual participants: {message.participantEmails.join(', ')}</Typography>
        {selected && <>
          <Autocomplete multiple options={options} value={chosen} disabled={disabled} disableCloseOnSelect
            isOptionEqualToValue={(option, value) => option.id === value.id}
            getOptionLabel={option => `${option.name} — ${option.email} — ${option.company || 'No company'}`}
            onChange={(_, values) => {
              const remaining = values.find(contact => contact.organizationReference === selected.primaryOrganizationReference)
              onSelection(message.messageId, { contactIds: values.map(contact => contact.id), primaryOrganizationReference: remaining?.organizationReference || '' })
            }}
            renderInput={params => <TextField {...params} label="Actual participant contacts" helperText="Select existing contacts from these message headers. Names, quoted text, and Reply-To do not create a match." />} />
          <TextField select fullWidth label="Primary company" value={selected.primaryOrganizationReference} disabled={disabled}
            onChange={event => onSelection(message.messageId, { ...selected, primaryOrganizationReference: event.target.value })}>
            <MenuItem value="">Select a selected contact’s company</MenuItem>
            {companies.map(company => <MenuItem key={company.organizationId} value={company.organizationReference}>
              {company.company} · {company.organizationReference}
            </MenuItem>)}
          </TextField>
          {!options.length && <Alert severity="warning">No active contact linked to a company in this pipeline matches these message headers.</Alert>}
        </>}
      </Stack>
    })}
  </Stack>
}

async function requestJson<T extends { ok?: boolean; error?: string }>(url: string, controller: AbortController, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal })
  const body = await response.json() as T
  if (!response.ok || body.ok !== true) throw new Error(body.error || 'Email review is unavailable')
  return body
}

export default function EmailReviewDialog({ pipelineId, onApplied }: {
  pipelineId: string; onApplied?: () => void
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]), [clientId, setClientId] = useState('')
  const [connectionId, setConnectionId] = useState(''), [decisionKind, setDecisionKind] = useState<Decision>('review')
  const [correctionReason, setCorrectionReason] = useState(''), [participantEmail, setParticipantEmail] = useState('')
  const [candidates, setCandidates] = useState<EmailReviewCandidate[]>([]), [selections, setSelections] = useState<Record<string, Selection>>({})
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [repairingMailbox, setRepairingMailbox] = useState(false), [labelPreview, setLabelPreview] = useState<MailboxLabelPreview | null>(null)
  // Google credentials are short-lived, memory-only command proof, never UI
  // props, rendered state, browser storage, logs, URLs or message-review input.
  const labelProof = useRef<MailboxLabelProof | null>(null)
  const activeRequest = useRef<AbortController | null>(null), pending = useRef(false), revision = useRef(0)
  const googleButton = useRef<HTMLDivElement | null>(null)
  const mailbox = mailboxes.find(value => value.connectionId === connectionId)
  // Presentation only; the server independently pins the owner, cache rows,
  // source pipeline and full evidence. Other workspaces need no one-off action.
  const caseyAvailable = pipelineId === '587c8746-ecf6-40ae-8c50-e456f99ad555'
    && connectionId === 'eb13a0fd-c0b2-4ad1-99b7-3bbda178a027'
  const command = emailReviewCommand({ pipelineId, connectionId, decisionKind, correctionReason, participantEmail, candidates, selections })
  const inputKey = command ? JSON.stringify(command) : ''
  const invalidate = useCallback((clearNotice = true) => { revision.current++; setPreview(null); if (clearNotice) setNotice('') }, [])
  const clearMailboxRepair = useCallback(() => { labelProof.current = null; setLabelPreview(null); setRepairingMailbox(false) }, [])
  const begin = useCallback(() => {
    activeRequest.current?.abort()
    const controller = new AbortController(); activeRequest.current = controller
    pending.current = true; setBusy(true); setError('')
    return controller
  }, [])
  const finish = useCallback((controller: AbortController) => {
    if (activeRequest.current === controller) { pending.current = false; setBusy(false) }
  }, [])
  useEffect(() => () => { activeRequest.current?.abort(); labelProof.current = null }, [])
  useEffect(() => {
    activeRequest.current?.abort(); pending.current = false; setBusy(false)
    clearMailboxRepair(); invalidate(); setOpen(false)
  }, [pipelineId, clearMailboxRepair, invalidate])
  useEffect(() => {
    if (!labelPreview) return
    const timer = setTimeout(() => {
      labelProof.current = null; setLabelPreview(null)
      setError('The address review expired. Verify the Google account again before confirming.')
    }, Math.max(0, Math.min(5 * 60_000, Date.parse(labelPreview.expiresAt) - Date.now())))
    return () => clearTimeout(timer)
  }, [labelPreview])
  const loadCandidates = useCallback(async (selectedConnection: string, exactParticipant = '') => {
    invalidate(false); setCandidates([]); setSelections({})
    const controller = begin()
    try {
      const params = new URLSearchParams({ pipelineId, connectionId: selectedConnection,
        ...(decisionKind === 'casey-history' ? { admissionScope: 'casey-reviewed-two-v1' } : {}),
        ...(exactParticipant ? { participantEmail: exactParticipant.trim().toLowerCase() } : {}) })
      const body = await requestJson<{ ok?: boolean; error?: string; pipelineId?: string; connectionId?: string
        messages?: EmailReviewCandidate[]; admissionScope?: string }>(`/api/crm/email-review-candidates?${params}`, controller)
      if (!controller.signal.aborted) {
        if (body.pipelineId !== pipelineId || body.connectionId !== selectedConnection) {
          throw new Error('Cached messages do not match the selected pipeline and mailbox.')
        }
        if (decisionKind === 'casey-history' && (body.admissionScope !== 'casey-reviewed-two-v1'
          || !Array.isArray(body.messages) || body.messages.length !== 2
          || body.messages.some(message => message.admissionScope !== 'casey-reviewed-two-v1' || !message.legacy))) {
          throw new Error('Both reviewed Casey messages are required. The retained records may have changed; no recovery was applied.')
        }
        setCandidates((body.messages || []).slice(0, decisionKind === 'casey-history' ? 2 : 25))
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Cached messages could not be loaded') }
    finally { finish(controller) }
  }, [begin, decisionKind, finish, invalidate, pipelineId])

  async function show() {
    clearMailboxRepair(); invalidate(); setOpen(true); setCandidates([]); setSelections({}); setConnectionId(''); setMailboxes([])
    setDecisionKind('review'); setCorrectionReason(''); setParticipantEmail('')
    const controller = begin()
    try {
      const body = await requestJson<{ ok?: boolean; error?: string; clientId?: string; mailboxes?: Mailbox[] }>(
        `/api/crm/mailbox-identity?pipelineId=${encodeURIComponent(pipelineId)}`, controller)
      if (controller.signal.aborted) return
      setClientId(body.clientId || ''); setMailboxes(body.mailboxes || []); setConnectionId(body.mailboxes?.[0]?.connectionId || '')
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Mailbox settings could not be loaded') }
    finally { finish(controller) }
  }
  useEffect(() => {
    if (open && connectionId && mailbox?.verified && !repairingMailbox && decisionKind !== 'late-contact') void loadCandidates(connectionId)
  }, [open, connectionId, mailbox?.verified, repairingMailbox, decisionKind, loadCandidates])

  useEffect(() => {
    if (!open || !clientId || !connectionId || (mailbox?.verified && !repairingMailbox) || labelPreview || !googleButton.current) return
    let active = true
    const button = googleButton.current
    void loadGoogleIdentityServices().then(() => {
      if (!active || !window.google?.accounts.id) return
      window.google.accounts.id.initialize({ client_id: clientId, auto_select: false, cancel_on_tap_outside: true,
        callback: response => {
          if (!active || pending.current) return
          if (!response.credential) { setError('Google did not return an identity token'); return }
          invalidate()
          const controller = begin()
          const idToken = response.credential
          const request = repairingMailbox
            ? { action: 'preview-label-repair', pipelineId, connectionId, idToken }
            : { pipelineId, connectionId, idToken: response.credential }
          void requestJson<{ ok?: boolean; error?: string; repair?: unknown; accountEmail?: string }>('/api/crm/mailbox-identity', controller,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
            .then(body => {
              if (controller.signal.aborted || !active) return
              if (repairingMailbox) {
                if (!validMailboxLabelPreview(body.repair)) throw new Error('A valid address review was not returned')
                const review = body.repair
                if (!review.required) {
                  clearMailboxRepair()
                  setMailboxes(values => values.map(value => value.connectionId === connectionId ? { ...value, accountEmail: review.newAccountEmail } : value))
                  setNotice('The saved address already matches Google. Use normal mailbox verification if it is still needed.')
                  return
                }
                labelProof.current = { pipelineId, connectionId, idToken, expectedDigest: review.expectedDigest, expiresAt: review.expiresAt }
                setLabelPreview(review)
              } else {
                setMailboxes(values => values.map(value => value.connectionId === connectionId
                  ? { ...value, accountEmail: body.accountEmail || value.accountEmail, verified: true } : value))
              }
            }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Google mailbox could not be verified') })
            .finally(() => finish(controller))
        } })
      window.google.accounts.id.renderButton(button, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', width: 300 })
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Google verification could not be loaded') })
    return () => { active = false; window.google?.accounts.id.cancel(); button.replaceChildren() }
  }, [open, clientId, connectionId, mailbox?.verified, repairingMailbox, labelPreview, pipelineId, begin, finish, invalidate, clearMailboxRepair])

  async function applyMailboxLabelRepair() {
    const proof = labelProof.current, reviewed = labelPreview
    if (pending.current || !proof || !reviewed || !repairingMailbox || proof.pipelineId !== pipelineId || proof.connectionId !== connectionId
      || proof.expectedDigest !== reviewed.expectedDigest || proof.expiresAt !== reviewed.expiresAt || Date.parse(proof.expiresAt) <= Date.now()) return
    invalidate(); const controller = begin()
    try {
      const body = await requestJson<{ ok?: boolean; error?: string; accountEmail?: string; verified?: boolean; connectionLabelUpdated?: boolean }>(
        '/api/crm/mailbox-identity', controller, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'apply-label-repair', pipelineId, connectionId, idToken: proof.idToken,
            expectedDigest: proof.expectedDigest, expiresAt: proof.expiresAt }) })
      // Local expiry clears retained credentials, but cannot undo an already
      // accepted server command. Acknowledge its exact response while this
      // request/scope is still current; navigation aborts or supersedes it.
      if (controller.signal.aborted || activeRequest.current !== controller) return
      if (body.accountEmail !== reviewed.newAccountEmail || body.verified !== true || body.connectionLabelUpdated !== true) {
        throw new Error('The address update was not confirmed. Reload mailbox settings before another review.')
      }
      setError('')
      clearMailboxRepair()
      setMailboxes(values => values.map(value => value.connectionId === connectionId ? { ...value, accountEmail: body.accountEmail!, verified: true } : value))
      setNotice('The connected Gmail address is updated. Historical messages still require their separate reviewed recovery.')
    } catch (cause) {
      if (!controller.signal.aborted) {
        labelProof.current = null; setLabelPreview(null)
        setError(cause instanceof Error ? cause.message : 'Address update was not confirmed. Review the current connection before trying again.')
      }
    } finally { finish(controller) }
  }

  async function submit(apply: boolean) {
    if (!command || pending.current || !mailbox?.verified || repairingMailbox || (apply && (!preview || preview.inputKey !== inputKey))) return
    const reviewed = preview, capturedRevision = revision.current, controller = begin()
    if (!apply) setPreview(null)
    try {
      const body = await requestJson<{ ok?: boolean; error?: string; recovery?: { applied: boolean; digest: string; messages: ReviewedMessage[] } }>(
        '/api/crm/email-recovery', controller, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...command, apply, ...(apply ? { expectedDigest: reviewed!.digest } : {}) }) })
      if (controller.signal.aborted || capturedRevision !== revision.current) return
      if (!body.recovery || body.recovery.applied !== apply || !/^[a-f0-9]{64}$/.test(body.recovery.digest)) throw new Error('A valid reviewed result was not returned')
      if (!Array.isArray(body.recovery.messages) || body.recovery.messages.length !== command.messageIds.length
        || [...new Set(body.recovery.messages.map(message => message.messageId))].sort().join() !== command.messageIds.join()
        || body.recovery.messages.some(message => !Array.isArray(message.organizationReferences) || !Array.isArray(message.contactReferences))) {
        throw new Error('The preview does not match the selected messages')
      }
      if (apply) { setPreview(null); setNotice('Selected messages were reconciled. Native CRM sync stays held until its identity, links and unchanged reader audience are verified.'); onApplied?.() }
      else setPreview({ digest: body.recovery.digest, inputKey, messages: body.recovery.messages })
    } catch (cause) {
      if (!controller.signal.aborted) { setPreview(null); setError(cause instanceof Error ? cause.message : 'Review changed; preview again before applying') }
    } finally { finish(controller) }
  }

  return <>
    <Button size="small" startIcon={<EmailRounded />} onClick={() => { void show() }}>Review email</Button>
    <Dialog open={open} onClose={() => { if (!busy) { activeRequest.current?.abort(); clearMailboxRepair(); invalidate(); setOpen(false) } }} fullWidth maxWidth="md">
      <DialogTitle>Review selected Gmail messages</DialogTitle>
      <DialogContent><Stack gap={2} sx={{ pt: 1 }}>
        <Alert severity="info">One email can appear in both company histories. Contacts keep their own company. This does not add pipeline readers or make a rule for future messages in the thread.</Alert>
        <Typography variant="body2">Review at most 25 selected cached messages. Historical recovery uses the original fixed three messages or a separate reviewed Casey pair, never a combined five-message batch or mailbox replay.</Typography>
        {error && <Alert severity="error">{error}</Alert>}{notice && <Alert severity="success">{notice}</Alert>}
        {busy && <CircularProgress size={22} aria-label="Working on selected email review" />}
        <TextField select label="Linked Google mailbox" value={connectionId} disabled={busy} onChange={event => {
          clearMailboxRepair(); invalidate(); setConnectionId(event.target.value); setCandidates([]); setSelections({})
          if (decisionKind === 'casey-history') setDecisionKind('review')
        }}>
          <MenuItem value="">Select a linked mailbox</MenuItem>
          {mailboxes.map(value => <MenuItem key={value.connectionId} value={value.connectionId}>{value.accountEmail} · {value.verified ? 'Verified identity' : 'Verify identity first'}</MenuItem>)}
        </TextField>
        {mailbox && <Stack gap={1}>
          <Button disabled={busy || repairingMailbox} onClick={() => {
            invalidate(); labelProof.current = null; setLabelPreview(null); setRepairingMailbox(true); setCandidates([]); setSelections({})
          }}>Review saved mailbox address</Button>
          <Typography variant="caption" color="text.secondary">Use this if Google’s current mailbox address differs from the saved label, including a changed primary address.</Typography>
        </Stack>}
        {mailbox && (!mailbox.verified || repairingMailbox) && !labelPreview && <>
          <Alert severity="warning">{repairingMailbox
            ? 'Verify the Google account connected to this inbox. The next step previews its saved and current addresses; nothing changes until you confirm.'
            : 'Continue with the same Google account as this mailbox. The server verifies Google’s signed token and independently checks the Gmail account. No Google subject is entered manually.'}</Alert>
          {clientId ? <Box ref={googleButton} sx={{ minHeight: 44, pointerEvents: busy ? 'none' : 'auto' }} />
            : <Alert severity="warning">Google mailbox verification is not configured. Ask the workspace administrator to configure Google sign-in before continuing.</Alert>}
        </>}
        {repairingMailbox && labelPreview && <MailboxLabelRepairFields preview={labelPreview} busy={busy}
          onConfirm={() => { void applyMailboxLabelRepair() }} onCancel={() => { clearMailboxRepair(); invalidate() }} />}
        {repairingMailbox && !labelPreview && <Button disabled={busy} onClick={() => { clearMailboxRepair(); invalidate() }}>Cancel address review</Button>}
        {!mailboxes.length && !busy && <Alert severity="warning">Select an active Google Mail connection in Settings → Integrations first.</Alert>}
        <TextField select label="Review action" value={decisionKind} disabled={busy || repairingMailbox} onChange={event => {
          invalidate(); setDecisionKind(event.target.value as Decision); setCandidates([]); setSelections({})
        }}>
          <MenuItem value="review">Review company and contact links</MenuItem><MenuItem value="correction">Correct a reviewed decision</MenuItem>
          <MenuItem value="late-contact">Reconcile a newly added contact</MenuItem>
          {(caseyAvailable || decisionKind === 'casey-history') && <MenuItem value="casey-history" disabled={!caseyAvailable}>Recover the separately reviewed Casey pair</MenuItem>}
        </TextField>
        {decisionKind === 'correction' && <TextField label="Reason for correction" required multiline inputProps={{ maxLength: 500 }}
          value={correctionReason} disabled={busy} onChange={event => { invalidate(); setCorrectionReason(event.target.value) }} />}
        {decisionKind === 'late-contact' && <Stack gap={1}>
          <TextField label="Exact participant email" type="email" value={participantEmail} disabled={busy} inputProps={{ maxLength: 254 }}
            onChange={event => { invalidate(); setParticipantEmail(event.target.value); setCandidates([]); setSelections({}) }} />
          <Button disabled={busy || repairingMailbox || !mailbox?.verified || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(participantEmail.trim())}
            onClick={() => { void loadCandidates(connectionId, participantEmail) }}>Find bounded cached participant messages</Button>
        </Stack>}
        {mailbox?.verified && decisionKind !== 'late-contact' && <Button disabled={busy || repairingMailbox} onClick={() => { void loadCandidates(connectionId) }}>Refresh cached candidates</Button>}
        <EmailReviewFields candidates={candidates} selections={selections} disabled={busy || repairingMailbox}
          onSelection={(messageId, selection) => { invalidate(); setSelections(current => {
            const next = { ...current }; if (selection) next[messageId] = selection; else delete next[messageId]; return next
          }) }} />
        {decisionKind === 'casey-history' && <Alert severity="warning">This separate recovery accepts only both reviewed Casey messages, with Globus as primary and Airspace related. The server rechecks their exact retained records, complete current content and actual participants. Original historical mailbox provenance remains unknown; this does not change the original three-message bridge or create a future thread rule.</Alert>}
        {decisionKind !== 'casey-history' && candidates.some(message => message.legacy && selections[message.messageId]) && <Alert severity="warning">All three allowlisted legacy messages must be reviewed together, with Globus as the approved primary company and Airspace related. The server verifies the exact references. No additional legacy message can be included.</Alert>}
        {preview && preview.inputKey === inputKey && <Stack gap={1}>
          <Typography variant="subtitle2">Reviewed preview — {preview.messages.length} selected messages</Typography>
          {preview.messages.map(message => <Typography key={message.messageId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {message.subject} · Companies: {message.organizationReferences.join(', ')} · Contacts: {message.contactReferences.join(', ')}{message.alreadyLinked ? ' · Already linked' : ''}
          </Typography>)}
          <Alert severity="info">Apply rechecks this exact preview. Any changed contact, company, message, mailbox, or audience requires a fresh review.</Alert>
        </Stack>}
      </Stack></DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button disabled={busy} onClick={() => { activeRequest.current?.abort(); clearMailboxRepair(); invalidate(); setOpen(false) }}>Close</Button>
        <Button disabled={busy || repairingMailbox || !mailbox?.verified || !command} onClick={() => { void submit(false) }}>Preview selected messages</Button>
        <Button variant="contained" disabled={busy || repairingMailbox || !mailbox?.verified || !preview || preview.inputKey !== inputKey || !command}
          onClick={() => { void submit(true) }}>Apply reviewed selection</Button>
      </DialogActions>
    </Dialog>
  </>
}
