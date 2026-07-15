'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import AddLinkRounded from '@mui/icons-material/AddLinkRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import type { ShortLinkRecord, ShortLinkWriteInput } from './types'

type FormValues = {
  destinationUrl: string
  title: string
  slug: string
  slugLength: string
  tags: string
  durationHours: string
  maxClicks: string
}

type Props = {
  open: boolean
  record: ShortLinkRecord | null
  busy: boolean
  onClose: () => void
  onSubmit: (input: ShortLinkWriteInput) => Promise<void>
}

const EMPTY_FORM: FormValues = {
  destinationUrl: '',
  title: '',
  slug: '',
  slugLength: '7',
  tags: '',
  durationHours: '24',
  maxClicks: '',
}

const fieldSx = {
  '& .MuiOutlinedInput-root': {
    borderRadius: '8px',
    backgroundColor: '#20202A',
  },
}

function durationFrom(record: ShortLinkRecord): string {
  if (!record.expiresAt) return ''
  const milliseconds = Date.parse(record.expiresAt) - Date.now()
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return ''
  return String(Math.max(1, Math.ceil(milliseconds / (60 * 60 * 1000))))
}

function valuesFrom(record: ShortLinkRecord | null): FormValues {
  if (!record) return EMPTY_FORM
  return {
    destinationUrl: record.destinationUrl,
    title: record.title,
    slug: record.slug,
    slugLength: '7',
    tags: record.tags.join(', '),
    durationHours: durationFrom(record),
    maxClicks: record.maxClicks == null ? '' : String(record.maxClicks),
  }
}

function normalizedTags(value: string): string[] {
  return Array.from(new Set(
    value
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  ))
}

function positiveInteger(value: string, label: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive whole number`)
  return parsed
}

function validatedDestination(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Destination must be a valid URL')
  }
  const localDevelopmentUrl = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localDevelopmentUrl) {
    throw new Error('Destination must use HTTPS')
  }
  return url.toString()
}

function sameTags(left: string[], right: string[]) {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

export default function ShortLinkFormDialog({ open, record, busy, onClose, onSubmit }: Props) {
  const theme = useTheme()
  const narrowScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const shortViewport = useMediaQuery('(max-height: 500px)')
  const fullScreen = narrowScreen || shortViewport
  const [values, setValues] = useState<FormValues>(EMPTY_FORM)
  const [initialValues, setInitialValues] = useState<FormValues>(EMPTY_FORM)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const nextValues = valuesFrom(record)
    setValues(nextValues)
    setInitialValues(nextValues)
    setError('')
  }, [open, record])

  const dirty = useMemo(
    () => Object.keys(values).some((key) => values[key as keyof FormValues] !== initialValues[key as keyof FormValues]),
    [initialValues, values],
  )

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    try {
      const destinationUrl = validatedDestination(values.destinationUrl)
      const title = values.title.trim()
      const slug = values.slug.trim().toLowerCase()
      const slugLength = positiveInteger(values.slugLength, 'Slug length')
      const tags = normalizedTags(values.tags)
      const durationHours = positiveInteger(values.durationHours, 'Expiration duration')
      const maxClicks = positiveInteger(values.maxClicks, 'Click cap')

      if (slug && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(slug)) {
        throw new Error('Custom slug must be 3-64 lowercase letters, numbers, hyphens, or underscores')
      }
      if (!slug && (slugLength === null || slugLength < 4 || slugLength > 32)) {
        throw new Error('Slug length must be between 4 and 32 characters')
      }

      if (!record) {
        await onSubmit({ destinationUrl, title, slug, slugLength: slug ? undefined : slugLength || 7, tags, durationHours, maxClicks })
        return
      }

      const initialTags = normalizedTags(initialValues.tags)
      const updates: ShortLinkWriteInput = {}
      if (destinationUrl !== validatedDestination(initialValues.destinationUrl)) updates.destinationUrl = destinationUrl
      if (title !== initialValues.title.trim()) updates.title = title
      if (slug !== initialValues.slug.trim().toLowerCase()) updates.slug = slug
      if (!sameTags(tags, initialTags)) updates.tags = tags
      if (values.durationHours !== initialValues.durationHours) updates.durationHours = durationHours
      if (values.maxClicks !== initialValues.maxClicks) updates.maxClicks = maxClicks
      if (Object.keys(updates).length === 0) {
        onClose()
        return
      }
      await onSubmit(updates)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to save short link')
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose() }}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="short-link-form-title"
      PaperProps={{
        sx: {
          borderRadius: fullScreen ? 0 : '8px',
          backgroundColor: '#1A1A23',
          border: { sm: '1px solid rgba(255,255,255,0.09)' },
        },
      }}
    >
      <Box component="form" onSubmit={submit} display="contents">
        <DialogTitle
          id="short-link-form-title"
          sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1.5, fontSize: '1.05rem', fontWeight: 700 }}
        >
          {record ? 'Edit short link' : 'Create short link'}
          <IconButton
            aria-label="Close short link form"
            onClick={onClose}
            disabled={busy}
            sx={{ ml: 'auto', color: 'text.secondary' }}
          >
            <CloseRounded />
          </IconButton>
        </DialogTitle>

        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, py: 2.5, borderColor: 'rgba(255,255,255,0.07)' }}>
          {error ? <Alert severity="error" sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
            <TextField
              autoFocus
              size="small"
              label="Title (optional)"
              value={values.title}
              onChange={(event) => update('title', event.target.value)}
              disabled={busy}
              inputProps={{ maxLength: 160 }}
              sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
            />
            <TextField
              required
              size="small"
              type="url"
              label="Destination URL"
              value={values.destinationUrl}
              onChange={(event) => update('destinationUrl', event.target.value)}
              disabled={busy}
              inputProps={{ maxLength: 2048 }}
              sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
            />
            <TextField
              size="small"
              label="Custom slug"
              value={values.slug}
              onChange={(event) => update('slug', event.target.value.toLowerCase().replace(/\s+/g, '-'))}
              disabled={busy}
              inputProps={{ maxLength: 64, autoCapitalize: 'none', spellCheck: false }}
              InputProps={{ startAdornment: <InputAdornment position="start">/</InputAdornment> }}
              sx={fieldSx}
            />
            {!record && !values.slug.trim() ? (
              <TextField
                size="small"
                type="number"
                label="Generated slug length"
                value={values.slugLength}
                onChange={(event) => update('slugLength', event.target.value)}
                disabled={busy}
                inputProps={{ min: 4, max: 32, step: 1, inputMode: 'numeric' }}
                sx={fieldSx}
              />
            ) : null}
            <TextField
              size="small"
              label="Tags"
              placeholder="campaign, social"
              value={values.tags}
              onChange={(event) => update('tags', event.target.value)}
              disabled={busy}
              inputProps={{ maxLength: 500 }}
              sx={fieldSx}
            />
            <TextField
              size="small"
              type="number"
              label="Expires after"
              value={values.durationHours}
              onChange={(event) => update('durationHours', event.target.value)}
              disabled={busy}
              inputProps={{ min: 1, step: 1, inputMode: 'numeric' }}
              InputProps={{ endAdornment: <InputAdornment position="end">hours</InputAdornment> }}
              sx={fieldSx}
            />
            <TextField
              size="small"
              type="number"
              label="Click cap"
              value={values.maxClicks}
              onChange={(event) => update('maxClicks', event.target.value)}
              disabled={busy}
              inputProps={{ min: 1, step: 1, inputMode: 'numeric' }}
              sx={fieldSx}
            />
          </Box>
          {record ? (
            <Typography variant="caption" color="text.disabled" display="block" mt={2}>
              {record.clickCount.toLocaleString()} clicks recorded
            </Typography>
          ) : null}
        </DialogContent>

        <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
          <Button onClick={onClose} disabled={busy} sx={{ minHeight: 38, borderRadius: '8px' }}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={busy || !values.destinationUrl.trim() || (Boolean(record) && !dirty)}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : record ? <SaveRounded /> : <AddLinkRounded />}
            sx={{ minHeight: 38, borderRadius: '8px', px: 2 }}
          >
            {record ? 'Save changes' : 'Create link'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}
