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
import CurrencyExchangeRounded from '@mui/icons-material/CurrencyExchangeRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import StraightenRounded from '@mui/icons-material/StraightenRounded'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import {
  SUPPORTED_ISO_4217_CURRENCY_CODES,
} from '@/lib/currency'
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
    organizationCurrencyCode,
    organizationRevision,
    userOverride,
    canManageOrganizationDefault,
    loading,
    error,
    preferencesWritable,
    setUserOverride,
    setOrganizationDefault,
    setOrganizationCurrencyCode,
  } = useMeasurementSystem()
  const [pending, setPending] = useState<
    'user' | 'organization-measurement' | 'organization-currency' | null
  >(null)
  const [notice, setNotice] = useState('')
  const [organizationDraft, setOrganizationDraft] =
    useState<MeasurementSystem>(organizationDefault)
  const [currencyDraft, setCurrencyDraft] = useState(organizationCurrencyCode)

  useEffect(() => {
    setOrganizationDraft(organizationDefault)
  }, [organizationDefault])

  useEffect(() => {
    setCurrencyDraft(organizationCurrencyCode)
  }, [organizationCurrencyCode])

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
    setPending('organization-measurement')
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

  async function updateOrganizationCurrency() {
    if (pending || currencyDraft === organizationCurrencyCode) return
    setPending('organization-currency')
    setNotice('')
    try {
      await setOrganizationCurrencyCode(currencyDraft)
      setNotice(
        `${organizationName || 'The active organization'} now defaults new ClawPilot-entered money to ${currencyDraft}.`,
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
      aria-labelledby="regional-preferences-title"
      sx={{ mt: 3, pt: 2.5, borderTop: '1px solid rgba(255,255,255,0.08)' }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
        <StraightenRounded color="primary" fontSize="small" />
        <Typography id="regional-preferences-title" variant="subtitle1" fontWeight={700}>
          Regional settings
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" mb={2}>
        Set organization defaults for money and measurements. ClawPilot keeps
        exact source currency and canonical measurements on records that own
        those facts.
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
                  pending === 'organization-measurement'
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

        <Divider />

        <Box>
          <Stack direction="row" spacing={1} alignItems="center" mb={0.75}>
            <CurrencyExchangeRounded color="primary" fontSize="small" />
            <Typography variant="subtitle2" fontWeight={700}>
              Organization currency
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" mb={1}>
            The ISO 4217 default is used only for new ClawPilot-entered money
            that has no record currency. Shopify, Faire, carrier, and imported
            money keeps its source currency and is never silently converted or
            relabeled.
          </Typography>
          {canManageOrganizationDefault ? (
            <Alert severity="info" variant="outlined" sx={{ mb: 1 }}>
              USD uses SuiteCRM&apos;s fixed base currency. Before saving another
              code, a root-organization ClawPilot owner or administrator must
              open native CRM from CRM &gt; Access SuiteCRM, then enable exactly
              one matching ISO currency under Admin &gt; Currencies and maintain
              its conversion rate.
            </Alert>
          ) : null}
          {!preferencesWritable ? (
            <Typography variant="body2" color="text.secondary">
              Organization currency becomes available after entering an active
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
                label="Default currency"
                value={currencyDraft}
                disabled={loading || Boolean(pending)}
                onChange={(event) => {
                  setCurrencyDraft(event.target.value)
                }}
                helperText={
                  currencyDraft === organizationCurrencyCode
                    ? `Saved currency · revision ${organizationRevision}`
                    : `Review, then save ${currencyDraft} for ${organizationName || 'the active organization'}.`
                }
              >
                {SUPPORTED_ISO_4217_CURRENCY_CODES.map((currencyCode) => (
                  <MenuItem key={currencyCode} value={currencyCode}>
                    {currencyCode}
                  </MenuItem>
                ))}
              </TextField>
              <Button
                variant="outlined"
                startIcon={
                  pending === 'organization-currency'
                    ? <CircularProgress size={16} color="inherit" />
                    : <SaveRounded />
                }
                disabled={
                  loading
                  || Boolean(pending)
                  || currencyDraft === organizationCurrencyCode
                }
                onClick={() => {
                  void updateOrganizationCurrency()
                }}
                sx={{
                  minWidth: 150,
                  minHeight: 40,
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                Save currency
              </Button>
            </Stack>
          ) : (
            <Alert severity="info" variant="outlined">
              The organization currency is {organizationCurrencyCode}. An
              organization owner or administrator can change it.
            </Alert>
          )}
        </Box>
      </Stack>

    </Box>
  )
}
