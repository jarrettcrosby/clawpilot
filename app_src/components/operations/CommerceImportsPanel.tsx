'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SettingsRounded from '@mui/icons-material/SettingsRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import CommerceIntakeWorkflow from '@/components/settings/CommerceIntakeWorkflow'
import ShopifyInventoryPanel from '@/components/operations/ShopifyInventoryPanel'

type CommerceProvider = 'shopify' | 'faire'

type CommerceAccount = {
  globalId: string
  provider: CommerceProvider
  environment: 'sandbox' | 'production'
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  verificationStatus: 'unverified' | 'verified' | 'failed'
}

type CommercePayload = {
  ok?: boolean
  error?: string
  canActivate?: boolean
  intakeAvailable?: boolean
  integrations?: {
    organizationId: string
    accounts: CommerceAccount[]
  }
}

function providerLabel(provider: CommerceProvider) {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function humanize(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export default function CommerceImportsPanel() {
  const [payload, setPayload] = useState<CommercePayload | null>(null)
  const [selectedAccountGlobalId, setSelectedAccountGlobalId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadRevision, setReloadRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/integrations/commerce', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const next = await response.json() as CommercePayload
        if (!response.ok || !next.integrations) {
          throw new Error(
            next.error || 'Sales-channel connections are unavailable.',
          )
        }
        return next
      })
      .then((next) => {
        setPayload(next)
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          return
        }
        setError(
          caught instanceof Error
            ? caught.message
            : 'Sales-channel connections are unavailable.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [reloadRevision])

  const accounts = useMemo(
    () => (payload?.integrations?.accounts || []).filter(
      (account) => (
        account.configured
        && account.verificationStatus === 'verified'
      ),
    ),
    [payload],
  )

  const effectiveSelectedAccountGlobalId = accounts.some(
    (account) => account.globalId === selectedAccountGlobalId,
  )
    ? selectedAccountGlobalId
    : accounts[0]?.globalId || ''

  const selectedAccount = accounts.find(
    (account) => account.globalId === effectiveSelectedAccountGlobalId,
  )

  if (loading && !payload) {
    return (
      <Box
        sx={{
          minHeight: 240,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <CircularProgress size={30} />
      </Box>
    )
  }

  return (
    <Stack
      spacing={2}
      sx={{
        px: { xs: 2, md: 3 },
        py: 2,
        maxWidth: 1040,
        mx: 'auto',
      }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
        gap={1.5}
      >
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>
            Choose a connected sales channel
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Import and review provider data here. Connect stores, rotate
            credentials, and manage provider setup in Settings.
          </Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button
            variant="outlined"
            startIcon={<RefreshRounded />}
            disabled={loading}
            onClick={() => {
              setLoading(true)
              setError('')
              setReloadRevision((revision) => revision + 1)
            }}
          >
            Refresh
          </Button>
          <Button
            variant="outlined"
            startIcon={<SettingsRounded />}
            href="/?settings=integrations&integration=commerce#operations/imports"
          >
            Manage connections
          </Button>
        </Stack>
      </Stack>

      {error ? <Alert severity="error">{error}</Alert> : null}

      {payload && payload.intakeAvailable !== true ? (
        <Alert severity="info">
          Commerce imports are unavailable in this runtime. Connection
          management remains available in Settings.
        </Alert>
      ) : null}

      {!error && payload?.intakeAvailable === true && accounts.length === 0 ? (
        <Alert
          severity="info"
          icon={<StorefrontRounded fontSize="inherit" />}
        >
          No verified Shopify or Faire connection is ready for import. Open
          connection settings to connect and verify a sales channel first.
        </Alert>
      ) : null}

      {payload?.intakeAvailable === true && accounts.length > 0 ? (
        <>
          <TextField
            select
            size="small"
            label="Sales channel"
            value={effectiveSelectedAccountGlobalId}
            onChange={(event) => {
              setSelectedAccountGlobalId(event.target.value)
            }}
            inputProps={{
              'aria-label': 'Select sales channel for commerce imports',
            }}
            sx={{ maxWidth: 480 }}
          >
            {accounts.map((account) => (
              <MenuItem key={account.globalId} value={account.globalId}>
                {account.displayName} · {providerLabel(account.provider)}
              </MenuItem>
            ))}
          </TextField>

          {selectedAccount ? (
            <>
              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Chip
                  size="small"
                  label={providerLabel(selectedAccount.provider)}
                  color="info"
                  variant="outlined"
                />
                <Chip
                  size="small"
                  label={humanize(selectedAccount.environment)}
                  variant="outlined"
                />
                <Chip
                  size="small"
                  label="API verified"
                  color="success"
                  variant="outlined"
                />
              </Stack>
              <CommerceIntakeWorkflow
                key={selectedAccount.globalId}
                accountGlobalId={selectedAccount.globalId}
                provider={selectedAccount.provider}
                displayName={selectedAccount.displayName}
                canActivate={payload.canActivate === true}
              />
              {selectedAccount.provider === 'shopify' ? (
                <ShopifyInventoryPanel
                  accountGlobalId={selectedAccount.globalId}
                  displayName={selectedAccount.displayName}
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </Stack>
  )
}
