'use client'

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { OrganizationWebDomain, OrganizationWebPreferences } from '@/lib/organizationWebPreferences'
import { WORKSPACE_CHANGED_EVENT } from '@/lib/workspaceClient'

type DomainChoice = { key: OrganizationWebDomain; label: string; url?: string }
type Payload = {
  ok: boolean; error?: string; canEdit: boolean; organizationName?: string
  preferences: OrganizationWebPreferences
  availableAppDomains: DomainChoice[]; availableShortLinkDomains: DomainChoice[]
  effectiveApp: DomainChoice & { url: string }; effectiveShortLink: DomainChoice
}

export default function OrganizationWebPreferencesPanel() {
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  useEffect(() => {
    const reset = () => setWorkspaceRevision((current) => current + 1)
    window.addEventListener(WORKSPACE_CHANGED_EVENT, reset)
    return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, reset)
  }, [])
  return <OrganizationWebPreferencesContent key={workspaceRevision} />
}

function OrganizationWebPreferencesContent() {
  const [state, setState] = useState<Payload | null>(null)
  const [draft, setDraft] = useState<OrganizationWebPreferences | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadRevision, setLoadRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    fetch('/api/settings/organization-web', { cache: 'no-store' }).then(async (response) => {
      const result = await response.json() as Payload
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load organization web settings')
      if (active) { setState(result); setDraft(result.preferences) }
    }).catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : 'Unable to load organization web settings') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [loadRevision])
  const dirty = Boolean(state && draft && (draft.appDomain !== state.preferences.appDomain || draft.shortLinkDomain !== state.preferences.shortLinkDomain || draft.allowUserShortLinkOverride !== state.preferences.allowUserShortLinkOverride))
  async function save() {
    if (!state?.canEdit || !draft || !dirty || saving) return
    setSaving(true); setError(''); setNotice('')
    try {
      const response = await fetch('/api/settings/organization-web', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedOrganizationId: draft.organizationId, appDomain: draft.appDomain, shortLinkDomain: draft.shortLinkDomain, allowUserShortLinkOverride: draft.allowUserShortLinkOverride, revision: draft.revision }) })
      const result = await response.json() as Payload
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to save organization web settings')
      setState(result); setDraft(result.preferences); setNotice('Organization web defaults saved. Existing links and this session are unchanged.')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save organization web settings') }
    finally { setSaving(false) }
  }
  if (loading) return <Box sx={{ mt: 3 }}><CircularProgress size={20} aria-label="Loading organization web settings" /></Box>
  if (!state || !draft) return error ? <Alert severity="error" sx={{ mt: 3 }} action={<Button color="inherit" size="small" onClick={() => setLoadRevision((current) => current + 1)}>Retry</Button>}>{error}</Alert> : null
  const disabled = !state.canEdit || saving
  const fallback = state.preferences.appDomain !== state.effectiveApp.key || state.preferences.shortLinkDomain !== state.effectiveShortLink.key
  function choices(available: DomainChoice[]) {
    return (['bpo', 'eigenracing'] as const).map((key) => {
      const choice = available.find((item) => item.key === key)
      return <MenuItem key={key} value={key} disabled={!choice}>{choice?.label || `${key === 'bpo' ? 'BPO Supply Chain' : 'Eigen Racing'} — not enabled`}</MenuItem>
    })
  }
  return <Box component="section" aria-labelledby="organization-web-heading" sx={{ mt: 3 }}>
    <Divider sx={{ mb: 2.5 }} />
    <Typography id="organization-web-heading" variant="subtitle2" fontWeight={700}>Organization web addresses</Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Defaults for {state.organizationName || 'this organization'}. BPO Supply Chain is preferred when its addresses are enabled.</Typography>
    {!state.canEdit && <Alert severity="info" sx={{ mb: 2 }}>Only an organization owner or administrator can change these defaults. You can still use either enabled app address.</Alert>}
    {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
    {notice && <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert>}
    {fallback && <Alert severity="info" sx={{ mb: 2 }}>A preferred address is not enabled yet. Currently using {state.effectiveApp.label} for app links and {state.effectiveShortLink.label} for short links. Saved preferences are preserved.</Alert>}
    <Stack spacing={2}>
      <TextField select fullWidth size="small" label="Default organization app address" value={draft.appDomain} disabled={disabled}
        helperText="Used for new organization invitations. Both enabled addresses still work; this does not redirect your current session or change provider callbacks."
        onChange={(event) => setDraft({ ...draft, appDomain: event.target.value as OrganizationWebDomain })}>{choices(state.availableAppDomains)}</TextField>
      <TextField select fullWidth size="small" label="Organization short-link default" value={draft.shortLinkDomain} disabled={disabled}
        helperText="Used for new browser-created links. Existing short links are never changed."
        onChange={(event) => setDraft({ ...draft, shortLinkDomain: event.target.value as OrganizationWebDomain })}>{choices(state.availableShortLinkDomains)}</TextField>
      <FormControlLabel control={<Switch checked={draft.allowUserShortLinkOverride} disabled={disabled}
        onChange={(_, checked) => setDraft({ ...draft, allowUserShortLinkOverride: checked })} />} label="Allow users to choose their own short-link default and per-link domain" />
      <Typography variant="caption" color="text.secondary">Email sender and calendar identities are managed separately in Settings → Integrations → Maton → Organization communication identities. Only provider-verified sender addresses can be used; web defaults do not change the sender.</Typography>
      <Stack direction="row" flexWrap="wrap" useFlexGap gap={1}>
        <Button component="a" href={state.effectiveApp.url} target="_blank" rel="noopener noreferrer">Open organization app</Button>
        {state.canEdit && <Button type="button" variant="contained" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save organization web defaults'}</Button>}
      </Stack>
    </Stack>
  </Box>
}
