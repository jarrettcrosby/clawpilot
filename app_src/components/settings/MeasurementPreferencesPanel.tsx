'use client'

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import SaveRounded from '@mui/icons-material/SaveRounded'
import StraightenRounded from '@mui/icons-material/StraightenRounded'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import type { MeasurementSystem } from '@/lib/measurements'

type PersonalSelection = MeasurementSystem | 'organization'

const systemLabel = (value: MeasurementSystem) => (
  value === 'imperial' ? 'Imperial (in, lb, ft³)' : 'Metric (cm, kg, m³)'
)

export default function MeasurementPreferencesPanel({
  organizationName,
}: {
  organizationName?: string | null
}) {
  const {
    measurementSystem,
    effectiveSource,
    organizationDefault,
    organizationRevision,
    userOverride,
    canManageOrganizationDefault,
    loading,
    error,
    preferencesWritable,
    setUserOverride,
    setOrganizationDefault,
  } = useMeasurementSystem()
  const [pending, setPending] = useState<'user' | 'organization' | null>(null)
  const [notice, setNotice] = useState('')
  const [organizationDraft, setOrganizationDraft] =
    useState<MeasurementSystem>(organizationDefault)

  useEffect(() => {
    setOrganizationDraft(organizationDefault)
  }, [organizationDefault])

  async function updateUserPreference(value: PersonalSelection) {
    if (pending) return
    setPending('user')
    setNotice('')
    try {
      await setUserOverride(value === 'organization' ? null : value)
      setNotice(value === 'organization'
        ? 'Your display units now follow the organization default.'
        : `Your display units are now ${value}.`)
    } catch {
      // The shared provider exposes the safe server error in this panel.
    } finally {
      setPending(null)
    }
  }

  async function updateOrganizationPreference() {
    if (pending || organizationDraft === organizationDefault) return
    setPending('organization')
    setNotice('')
    try {
      await setOrganizationDefault(organizationDraft)
      setNotice(
        `${organizationName || 'The active organization'} now defaults to ${organizationDraft}.`,
      )
    } catch {
      // The shared provider exposes the safe server error in this panel.
    } finally {
      setPending(null)
    }
  }

  const personalSelection: PersonalSelection = userOverride || 'organization'

  return (
    <Box
      component="section"
      aria-labelledby="measurement-preferences-title"
      sx={{ mt: 3, pt: 2.5, borderTop: '1px solid rgba(255,255,255,0.08)' }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
        <StraightenRounded color="primary" fontSize="small" />
        <Typography id="measurement-preferences-title" variant="subtitle1" fontWeight={700}>
          Measurement units
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" mb={2}>
        ClawPilot stores exact canonical measurements for planning and audit evidence,
        then converts the operator display and entry fields to your selected system.
      </Typography>

      {error ? <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 1.5 }}>{notice}</Alert> : null}

      <Stack spacing={2}>
        <Box>
          <Typography variant="subtitle2" fontWeight={700} mb={0.75}>
            Your display preference
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-start' }}>
            <TextField
              select
              fullWidth
              size="small"
              label="Display measurements"
              value={personalSelection}
              disabled={!preferencesWritable || loading || Boolean(pending)}
              onChange={(event) => {
                void updateUserPreference(event.target.value as PersonalSelection)
              }}
              helperText={preferencesWritable
                ? `Currently showing ${systemLabel(measurementSystem)} from the ${
                  effectiveSource === 'user' ? 'personal override'
                    : effectiveSource === 'organization' ? 'organization default'
                      : 'safe fallback'
                }.`
                : `No active organization is available. This runtime uses the safe ${
                  systemLabel(measurementSystem)
                } fallback without saving a preference.`}
            >
              <MenuItem value="organization">
                Follow organization · {systemLabel(organizationDefault)}
              </MenuItem>
              <MenuItem value="imperial">{systemLabel('imperial')}</MenuItem>
              <MenuItem value="metric">{systemLabel('metric')}</MenuItem>
            </TextField>
            {pending === 'user' ? <CircularProgress size={20} sx={{ mt: 1 }} /> : null}
          </Stack>
        </Box>

        <Divider />

        <Box>
          <Typography variant="subtitle2" fontWeight={700} mb={0.75}>
            Organization default
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={1}>
            Applies to {organizationName || 'the active organization'} for people
            without a personal override.
          </Typography>
          {!preferencesWritable ? (
            <Typography variant="body2" color="text.secondary">
              Organization defaults become available after entering an active
              organization.
            </Typography>
          ) : canManageOrganizationDefault ? (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ sm: 'flex-start' }}
            >
              <TextField
                select
                fullWidth
                size="small"
                label="Default measurement system"
                value={organizationDraft}
                disabled={loading || Boolean(pending)}
                onChange={(event) => {
                  setOrganizationDraft(event.target.value as MeasurementSystem)
                }}
                helperText={
                  organizationDraft === organizationDefault
                    ? `Saved default · revision ${organizationRevision}`
                    : `Review, then save this change for ${organizationName || 'the active organization'}.`
                }
              >
                <MenuItem value="imperial">{systemLabel('imperial')}</MenuItem>
                <MenuItem value="metric">{systemLabel('metric')}</MenuItem>
              </TextField>
              <Button
                variant="outlined"
                startIcon={
                  pending === 'organization'
                    ? <CircularProgress size={16} color="inherit" />
                    : <SaveRounded />
                }
                disabled={
                  loading
                  || Boolean(pending)
                  || organizationDraft === organizationDefault
                }
                onClick={() => {
                  void updateOrganizationPreference()
                }}
                sx={{ minWidth: 150, minHeight: 40 }}
              >
                Save default
              </Button>
            </Stack>
          ) : (
            <Alert severity="info" variant="outlined">
              The organization default is {systemLabel(organizationDefault)}. An organization
              owner or administrator can change it.
            </Alert>
          )}
        </Box>
      </Stack>

    </Box>
  )
}
