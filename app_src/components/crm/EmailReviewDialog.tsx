'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Autocomplete, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material'
import EmailRounded from '@mui/icons-material/EmailRounded'
import { loadGoogleIdentityServices } from '@/components/settings/GoogleAuthSettingsPanel'

type RecordValue = Record<string, unknown>
export type EmailReviewCandidate = { messageId: string; threadId: string; subject: string; receivedAt: string
  legacy: boolean; participantEmails: string[]; participantContactIds: string[] }
type Mailbox = { connectionId: string; accountEmail: string; verified: boolean }
type Selection = { contactIds: string[]; primaryOrganizationReference: string }
type Decision = 'review' | 'correction' | 'late-contact'
type ReviewedMessage = { messageId: string; subject: string; organizationReferences: string[]; contactReferences: string[]; alreadyLinked?: boolean }
type Preview = { digest: string; inputKey: string; messages: ReviewedMessage[] }
type ContactChoice = { id: string; reference: string; name: string; email: string; organizationId: string; company: string }
type CompanyChoice = { id: string; reference: string; name: string }

export function emailReviewCommand(input: { pipelineId: string; connectionId: string; decisionKind: Decision
  correctionReason: string; participantEmail: string; candidates: EmailReviewCandidate[]; selections: Record<string, Selection>
  contacts: ContactChoice[]; organizations: CompanyChoice[] }) {
  const selected = input.candidates.filter(message => Object.hasOwn(input.selections, message.messageId))
    .sort((a, b) => a.messageId.localeCompare(b.messageId))
  if (!input.connectionId || !selected.length || selected.length > 25
    || (input.decisionKind === 'correction' && (!input.correctionReason.trim() || input.correctionReason.trim().length > 500))
    || (input.decisionKind === 'late-contact' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.participantEmail.trim()))) return null
  if (selected.some(message => message.legacy)
    && (selected.length !== 3 || selected.some(message => !message.legacy)
      || input.candidates.filter(message => message.legacy).length !== 3)) return null
  const associations = selected.map(message => {
    const selection = input.selections[message.messageId]
    const contacts = selection.contactIds.map(id => input.contacts.find(contact => contact.id === id))
    const primary = input.organizations.find(company => company.reference === selection.primaryOrganizationReference)
    if (!contacts.length || contacts.length > 25 || new Set(selection.contactIds).size !== contacts.length
      || !primary || contacts.some(contact => !contact || !contact.reference
        || !message.participantContactIds.includes(contact.id) || !message.participantEmails.includes(contact.email))
      || (input.decisionKind === 'late-contact' && !contacts.some(contact => contact?.email === input.participantEmail.trim().toLowerCase()))
      || !contacts.some(contact => contact?.organizationId === primary.id)) return null
    return { messageId: message.messageId, threadId: message.threadId,
      primaryOrganizationReference: primary.reference,
      contactReferences: contacts.map(contact => contact!.reference).sort() }
  })
  if (associations.some(value => value === null)) return null
  return { pipelineId: input.pipelineId, connectionId: input.connectionId, messageIds: selected.map(message => message.messageId),
    reviewedAssociations: associations, decisionKind: input.decisionKind,
    ...(input.decisionKind === 'correction' ? { correctionReason: input.correctionReason.trim() } : {}),
    ...(input.decisionKind === 'late-contact' ? { participantEmail: input.participantEmail.trim().toLowerCase() } : {}) }
}

export function EmailReviewFields({ candidates, selections, contacts, organizations, disabled, onSelection }: {
  candidates: EmailReviewCandidate[]; selections: Record<string, Selection>; contacts: ContactChoice[]
  organizations: CompanyChoice[]; disabled: boolean; onSelection: (messageId: string, selection: Selection | null) => void
}) {
  return <Stack gap={2}>
    {candidates.map(message => {
      const selected = selections[message.messageId]
      const options = contacts.filter(contact => message.participantContactIds.includes(contact.id) && message.participantEmails.includes(contact.email))
      const chosen = selected ? contacts.filter(contact => selected.contactIds.includes(contact.id)) : []
      const companies = organizations.filter(company => chosen.some(contact => contact.organizationId === company.id))
      return <Stack key={message.messageId} gap={1} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
        <FormControlLabel control={<Checkbox checked={Boolean(selected)} disabled={disabled}
          onChange={(_, checked) => onSelection(message.messageId, checked ? { contactIds: [], primaryOrganizationReference: '' } : null)} />}
          label={<Typography sx={{ overflowWrap: 'anywhere' }}>{message.subject}</Typography>} />
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          Message {message.messageId} · {message.receivedAt} · {message.legacy ? 'Fixed three-message legacy review' : 'Verified mailbox cache'}
        </Typography>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>Actual participants: {message.participantEmails.join(', ')}</Typography>
        {selected && <>
          <Autocomplete multiple options={options} value={chosen} disabled={disabled} disableCloseOnSelect
            isOptionEqualToValue={(option, value) => option.id === value.id}
            getOptionLabel={option => `${option.name} — ${option.email} — ${option.company || 'No company'}`}
            onChange={(_, values) => {
              const remaining = organizations.find(company => company.reference === selected.primaryOrganizationReference
                && values.some(contact => contact.organizationId === company.id))
              onSelection(message.messageId, { contactIds: values.map(contact => contact.id), primaryOrganizationReference: remaining?.reference || '' })
            }}
            renderInput={params => <TextField {...params} label="Actual participant contacts" helperText="Select existing contacts from these message headers. Names, quoted text, and Reply-To do not create a match." />} />
          <TextField select fullWidth label="Primary company" value={selected.primaryOrganizationReference} disabled={disabled}
            onChange={event => onSelection(message.messageId, { ...selected, primaryOrganizationReference: event.target.value })}>
            <MenuItem value="">Select a selected contact’s company</MenuItem>
            {companies.map(company => <MenuItem key={company.id} value={company.reference}>{company.name} · {company.reference}</MenuItem>)}
          </TextField>
          {!options.length && <Alert severity="warning">No loaded CRM contact matches these actual headers. Create or load the correct contact first, then refresh this review.</Alert>}
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

export default function EmailReviewDialog({ pipelineId, contacts: contactRecords, organizations: companyRecords, onApplied }: {
  pipelineId: string; contacts: RecordValue[]; organizations: RecordValue[]; onApplied?: () => void
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]), [clientId, setClientId] = useState('')
  const [connectionId, setConnectionId] = useState(''), [decisionKind, setDecisionKind] = useState<Decision>('review')
  const [correctionReason, setCorrectionReason] = useState(''), [participantEmail, setParticipantEmail] = useState('')
  const [candidates, setCandidates] = useState<EmailReviewCandidate[]>([]), [selections, setSelections] = useState<Record<string, Selection>>({})
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const activeRequest = useRef<AbortController | null>(null), pending = useRef(false), revision = useRef(0)
  const googleButton = useRef<HTMLDivElement | null>(null)
  const mailbox = mailboxes.find(value => value.connectionId === connectionId)
  const contacts = useMemo(() => contactRecords.map(contact => ({ id: String(contact.id || ''), reference: String(contact.referenceCode || ''),
    name: String(contact.fullName || ''), email: String(contact.email || '').trim().toLowerCase(),
    organizationId: String(contact.organizationId || ''), company: String(contact.organizationName || '') })), [contactRecords])
  const organizations = useMemo(() => companyRecords.map(company => ({ id: String(company.id || ''), reference: String(company.referenceCode || ''), name: String(company.name || '') })), [companyRecords])
  const command = emailReviewCommand({ pipelineId, connectionId, decisionKind, correctionReason, participantEmail, candidates, selections, contacts, organizations })
  const inputKey = command ? JSON.stringify(command) : ''
  const invalidate = useCallback(() => { revision.current++; setPreview(null); setNotice('') }, [])
  const begin = useCallback(() => {
    activeRequest.current?.abort()
    const controller = new AbortController(); activeRequest.current = controller
    pending.current = true; setBusy(true); setError('')
    return controller
  }, [])
  const finish = useCallback((controller: AbortController) => {
    if (activeRequest.current === controller) { pending.current = false; setBusy(false) }
  }, [])
  useEffect(() => () => { activeRequest.current?.abort() }, [])
  useEffect(() => { invalidate() }, [contacts, organizations, invalidate])

  const loadCandidates = useCallback(async (selectedConnection: string, exactParticipant = '') => {
    invalidate(); setCandidates([]); setSelections({})
    const controller = begin()
    try {
      const params = new URLSearchParams({ pipelineId, connectionId: selectedConnection,
        ...(exactParticipant ? { participantEmail: exactParticipant.trim().toLowerCase() } : {}) })
      const body = await requestJson<{ ok?: boolean; error?: string; messages?: EmailReviewCandidate[] }>(`/api/crm/email-review-candidates?${params}`, controller)
      if (!controller.signal.aborted) setCandidates((body.messages || []).slice(0, 25))
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Cached messages could not be loaded') }
    finally { finish(controller) }
  }, [begin, finish, invalidate, pipelineId])

  async function show() {
    invalidate(); setOpen(true); setCandidates([]); setSelections({}); setConnectionId(''); setMailboxes([])
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
    if (open && connectionId && mailbox?.verified && decisionKind !== 'late-contact') void loadCandidates(connectionId)
  }, [open, connectionId, mailbox?.verified, decisionKind, loadCandidates])

  useEffect(() => {
    if (!open || !clientId || !connectionId || mailbox?.verified || !googleButton.current) return
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
          void requestJson('/api/crm/mailbox-identity', controller, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pipelineId, connectionId, idToken: response.credential }) })
            .then(() => {
              if (!controller.signal.aborted) setMailboxes(values => values.map(value => value.connectionId === connectionId ? { ...value, verified: true } : value))
            }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Google mailbox could not be verified') })
            .finally(() => finish(controller))
        } })
      window.google.accounts.id.renderButton(button, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', width: 300 })
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Google verification could not be loaded') })
    return () => { active = false; window.google?.accounts.id.cancel(); button.replaceChildren() }
  }, [open, clientId, connectionId, mailbox?.verified, pipelineId, begin, finish, invalidate])

  async function submit(apply: boolean) {
    if (!command || pending.current || !mailbox?.verified || (apply && (!preview || preview.inputKey !== inputKey))) return
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
    <Dialog open={open} onClose={() => { if (!busy) { activeRequest.current?.abort(); invalidate(); setOpen(false) } }} fullWidth maxWidth="md">
      <DialogTitle>Review selected Gmail messages</DialogTitle>
      <DialogContent><Stack gap={2} sx={{ pt: 1 }}>
        <Alert severity="info">One email can appear in both company histories. Contacts keep their own company. This does not add pipeline readers or make a rule for future messages in the thread.</Alert>
        <Typography variant="body2">Review at most 25 selected cached messages. The legacy bridge is limited to the fixed three messages; it is not a mailbox replay.</Typography>
        {error && <Alert severity="error">{error}</Alert>}{notice && <Alert severity="success">{notice}</Alert>}
        {busy && <CircularProgress size={22} aria-label="Working on selected email review" />}
        <TextField select label="Linked Google mailbox" value={connectionId} disabled={busy} onChange={event => {
          invalidate(); setConnectionId(event.target.value); setCandidates([]); setSelections({})
        }}>
          <MenuItem value="">Select a linked mailbox</MenuItem>
          {mailboxes.map(value => <MenuItem key={value.connectionId} value={value.connectionId}>{value.accountEmail} · {value.verified ? 'Verified identity' : 'Verify identity first'}</MenuItem>)}
        </TextField>
        {mailbox && !mailbox.verified && <>
          <Alert severity="warning">Continue with the same Google account as this mailbox. The server verifies Google’s signed token and independently checks the Gmail account. No Google subject is entered manually.</Alert>
          {clientId ? <Box ref={googleButton} sx={{ minHeight: 44, pointerEvents: busy ? 'none' : 'auto' }} />
            : <Alert severity="warning">Google mailbox verification is not configured. Ask the workspace administrator to configure Google sign-in before continuing.</Alert>}
        </>}
        {!mailboxes.length && !busy && <Alert severity="warning">Select an active Google Mail connection in Settings → Integrations first.</Alert>}
        <TextField select label="Review action" value={decisionKind} disabled={busy} onChange={event => {
          invalidate(); setDecisionKind(event.target.value as Decision); setCandidates([]); setSelections({})
        }}>
          <MenuItem value="review">Review company and contact links</MenuItem><MenuItem value="correction">Correct a reviewed decision</MenuItem>
          <MenuItem value="late-contact">Reconcile a newly added contact</MenuItem>
        </TextField>
        {decisionKind === 'correction' && <TextField label="Reason for correction" required multiline inputProps={{ maxLength: 500 }}
          value={correctionReason} disabled={busy} onChange={event => { invalidate(); setCorrectionReason(event.target.value) }} />}
        {decisionKind === 'late-contact' && <Stack gap={1}>
          <TextField label="Exact participant email" type="email" value={participantEmail} disabled={busy} inputProps={{ maxLength: 254 }}
            onChange={event => { invalidate(); setParticipantEmail(event.target.value); setCandidates([]); setSelections({}) }} />
          <Button disabled={busy || !mailbox?.verified || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(participantEmail.trim())}
            onClick={() => { void loadCandidates(connectionId, participantEmail) }}>Find bounded cached participant messages</Button>
        </Stack>}
        {mailbox?.verified && decisionKind !== 'late-contact' && <Button disabled={busy} onClick={() => { void loadCandidates(connectionId) }}>Refresh cached candidates</Button>}
        <EmailReviewFields candidates={candidates} selections={selections} contacts={contacts} organizations={organizations} disabled={busy}
          onSelection={(messageId, selection) => { invalidate(); setSelections(current => {
            const next = { ...current }; if (selection) next[messageId] = selection; else delete next[messageId]; return next
          }) }} />
        {candidates.some(message => message.legacy && selections[message.messageId]) && <Alert severity="warning">All three allowlisted legacy messages must be reviewed together, with Globus as the approved primary company and Airspace related. The server verifies the exact references. No additional legacy message can be included.</Alert>}
        {preview && preview.inputKey === inputKey && <Stack gap={1}>
          <Typography variant="subtitle2">Reviewed preview — {preview.messages.length} selected messages</Typography>
          {preview.messages.map(message => <Typography key={message.messageId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {message.subject} · Companies: {message.organizationReferences.join(', ')} · Contacts: {message.contactReferences.join(', ')}{message.alreadyLinked ? ' · Already linked' : ''}
          </Typography>)}
          <Alert severity="info">Apply rechecks this exact preview. Any changed contact, company, message, mailbox, or audience requires a fresh review.</Alert>
        </Stack>}
      </Stack></DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button disabled={busy} onClick={() => { activeRequest.current?.abort(); invalidate(); setOpen(false) }}>Close</Button>
        <Button disabled={busy || !mailbox?.verified || !command} onClick={() => { void submit(false) }}>Preview selected messages</Button>
        <Button variant="contained" disabled={busy || !mailbox?.verified || !preview || preview.inputKey !== inputKey || !command}
          onClick={() => { void submit(true) }}>Apply reviewed selection</Button>
      </DialogActions>
    </Dialog>
  </>
}
