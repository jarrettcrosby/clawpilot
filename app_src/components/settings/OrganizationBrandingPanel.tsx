'use client'

import { useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import ImageRounded from '@mui/icons-material/ImageRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'

type Branding = {
  organizationId: string
  organizationReferenceCode: string
  organizationName: string
  primaryColor: string
  accentColor: string
  hasCustomLogo: boolean
  logoUrl: string
  revision: number
}

type BrandingPayload = {
  ok?: boolean
  error?: string
  canEdit?: boolean
  branding?: Branding
  workbookRefresh?: string
}

export default function OrganizationBrandingPanel() {
  const [branding, setBranding] = useState<Branding | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [primaryColor, setPrimaryColor] = useState('#1F2430')
  const [accentColor, setAccentColor] = useState('#A8C7FA')
  const [logo, setLogo] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [removeLogo, setRemoveLogo] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/settings/organization-branding', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as BrandingPayload
        if (!response.ok || payload.ok === false || !payload.branding) {
          throw new Error(payload.error || 'Unable to load organization branding')
        }
        if (!active) return
        setBranding(payload.branding)
        setCanEdit(payload.canEdit === true)
        setPrimaryColor(payload.branding.primaryColor)
        setAccentColor(payload.branding.accentColor)
      })
      .catch((loadError) => active && setError(loadError instanceof Error ? loadError.message : 'Unable to load organization branding'))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  function selectLogo(file: File | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setLogo(file)
    setPreviewUrl(file ? URL.createObjectURL(file) : '')
    setRemoveLogo(false)
    setError('')
    setNotice('')
  }

  const dirty = Boolean(branding) && (
    primaryColor !== branding?.primaryColor
    || accentColor !== branding?.accentColor
    || Boolean(logo)
    || removeLogo
  )

  async function saveBranding() {
    if (!canEdit || !dirty || saving) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const body = new FormData()
      body.set('primaryColor', primaryColor)
      body.set('accentColor', accentColor)
      body.set('removeLogo', String(removeLogo))
      if (logo) body.set('logo', logo)
      const response = await fetch('/api/settings/organization-branding', { method: 'PUT', body })
      const payload = await response.json().catch(() => ({})) as BrandingPayload
      if (!response.ok || payload.ok === false || !payload.branding) {
        throw new Error(payload.error || 'Unable to save organization branding')
      }
      setBranding(payload.branding)
      setPrimaryColor(payload.branding.primaryColor)
      setAccentColor(payload.branding.accentColor)
      selectLogo(null)
      setRemoveLogo(false)
      setNotice(payload.workbookRefresh === 'queued' ? 'Branding saved. Workbook refresh queued.' : 'Branding saved.')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save organization branding')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <Box display="grid" sx={{ minHeight: 120, placeItems: 'center' }}><CircularProgress size={22} /></Box>
  }
  if (!branding) return error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null

  const displayedLogo = previewUrl || (!removeLogo ? branding.logoUrl : '/brand/email/clawpilot-mark-email.png')
  return (
    <Box sx={{ mt: 3 }}>
      <Divider sx={{ mb: 2.5, borderColor: 'rgba(255,255,255,0.08)' }} />
      <Typography variant="subtitle2" fontWeight={700}>Organization branding</Typography>
      <Typography variant="caption" color="text.secondary">Managed Google workbooks</Typography>
      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mt: 1.5 }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mt: 1.5 }}>{notice}</Alert> : null}
      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px 1fr' }, gap: 2 }}>
        <Box
          sx={{
            height: 126,
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 1,
            bgcolor: primaryColor,
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
          }}
        >
          <Box component="img" src={displayedLogo} alt={`${branding.organizationName} logo`} sx={{ maxWidth: 132, maxHeight: 82, objectFit: 'contain' }} />
        </Box>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              label="Primary color"
              type="color"
              value={primaryColor}
              onChange={(event) => setPrimaryColor(event.target.value.toUpperCase())}
              disabled={!canEdit || saving}
              InputLabelProps={{ shrink: true }}
              inputProps={{ 'aria-label': 'Organization primary color' }}
              fullWidth
              size="small"
            />
            <TextField
              label="Accent color"
              type="color"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value.toUpperCase())}
              disabled={!canEdit || saving}
              InputLabelProps={{ shrink: true }}
              inputProps={{ 'aria-label': 'Organization accent color' }}
              fullWidth
              size="small"
            />
          </Stack>
          {canEdit ? (
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <input
                ref={fileRef}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => selectLogo(event.target.files?.[0] || null)}
              />
              <Button type="button" variant="outlined" startIcon={<ImageRounded />} onClick={() => fileRef.current?.click()} disabled={saving}>
                Upload logo
              </Button>
              {(branding.hasCustomLogo || logo) && !removeLogo ? (
                <Button type="button" color="inherit" onClick={() => { selectLogo(null); setRemoveLogo(true) }} disabled={saving}>
                  Remove
                </Button>
              ) : null}
              <Button
                type="button"
                variant="contained"
                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
                onClick={saveBranding}
                disabled={!dirty || saving}
                sx={{ ml: { sm: 'auto' } }}
              >
                Save branding
              </Button>
            </Stack>
          ) : null}
        </Stack>
      </Box>
    </Box>
  )
}
