'use client'

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Collapse from '@mui/material/Collapse'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'

type CommerceProvider = 'shopify' | 'faire'
type Resource = 'orders' | 'inventory'
type Readiness =
  | 'ready'
  | 'degraded'
  | 'not_configured'
  | 'unavailable'
  | 'observation_only'

type Policy = {
  accountGlobalId: string
  provider: CommerceProvider
  resource: Resource
  authorityMode: 'provider' | 'observation_only'
  desiredIngestMode:
    | 'windowed_history_and_core_order_signals_plus_poll'
    | 'provider_available_history_and_continuous_poll'
    | 'current_snapshot_and_realtime'
    | 'observation_only'
  providerWriteMode: 'disabled'
  providerWriteCount: 0
  actualReadiness: {
    state: Readiness
    blockerCodes: string[]
  }
}

type AuthorityResponse = {
  ok?: boolean
  error?: string
  state?: {
    policies?: Policy[]
  }
}

function providerLabel(provider: CommerceProvider) {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function readinessLabel(value: Readiness) {
  switch (value) {
    case 'ready': return 'Ready'
    case 'degraded': return 'Needs attention'
    case 'observation_only': return 'Observation only'
    case 'not_configured': return 'Not configured'
    default: return 'Unavailable'
  }
}

function readinessColor(value: Readiness) {
  if (value === 'ready') return 'success' as const
  if (value === 'observation_only') return 'info' as const
  if (value === 'degraded') return 'warning' as const
  return 'default' as const
}

function detail(value: string) {
  return value
    .replace(/^COMMERCE_/u, '')
    .replace(/_/gu, ' ')
    .toLowerCase()
    .replace(/^\w/u, (letter) => letter.toUpperCase())
}

function resourceDescription(policy: Policy) {
  if (policy.resource === 'orders') {
    return policy.provider === 'shopify'
      ? 'Seven core Shopify order signals flow into read-only history, with scheduled polling as a recovery backstop. Delete, refund, and Return-resource signals remain outside this bounded mode; started warehouse work is reviewed instead of silently replaced.'
      : 'Faire changes flow into read-only history through continuous five-minute scheduled checks because Faire does not provide a supported webhook transport. Started warehouse work is reviewed instead of silently replaced.'
  }
  if (policy.authorityMode === 'observation_only') {
    return 'Faire quantities are retained as channel observations and do not set warehouse inventory.'
  }
  return 'Shopify quantities set the current warehouse inventory projection in ClawPilot.'
}

export default function CommerceAuthoritySummaryPanel({
  accountGlobalId,
  provider,
}: {
  accountGlobalId: string
  provider: CommerceProvider
}) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/integrations/commerce/authority-policies', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const next = await response.json() as AuthorityResponse
        if (!response.ok || !next.state?.policies) {
          throw new Error(next.error || 'Source authority is unavailable.')
        }
        return next.state.policies
      })
      .then((next) => {
        setPolicies(next.filter(
          (policy) => policy.accountGlobalId === accountGlobalId,
        ))
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setError(
          caught instanceof Error
            ? caught.message
            : 'Source authority is unavailable.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [accountGlobalId])

  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
      <Stack spacing={1.25}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          gap={1}
        >
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>
              System of record
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {providerLabel(provider)} supplies store facts. Store writeback is off.
            </Typography>
          </Box>
          <Chip size="small" variant="outlined" label="0 provider writes" />
        </Stack>

        {error ? <Alert severity="error">{error}</Alert> : null}
        {!error && !loading && policies.length === 0 ? (
          <Alert severity="info">
            Source authority has not been configured for this connection.
          </Alert>
        ) : null}

        {policies.map((policy, index) => (
          <Box key={`${policy.accountGlobalId}:${policy.resource}`}>
            {index > 0 ? <Divider sx={{ mb: 1.25 }} /> : null}
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              gap={1}
            >
              <Box>
                <Typography variant="body2" fontWeight={700}>
                  {policy.resource === 'orders' ? 'Orders' : 'Inventory'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {resourceDescription(policy)}
                </Typography>
              </Box>
              <Stack direction="row" spacing={0.75} flexWrap="wrap">
                <Chip
                  size="small"
                  variant="outlined"
                  label={
                    policy.authorityMode === 'observation_only'
                      ? 'Observation only'
                      : `${providerLabel(policy.provider)} authoritative`
                  }
                />
                <Chip
                  size="small"
                  color={readinessColor(policy.actualReadiness.state)}
                  variant="outlined"
                  label={readinessLabel(policy.actualReadiness.state)}
                />
              </Stack>
            </Stack>
          </Box>
        ))}

        {policies.some(
          (policy) => policy.actualReadiness.blockerCodes.length > 0,
        ) ? (
          <>
            <Button
              size="small"
              variant="text"
              endIcon={
                <ExpandMoreRounded
                  sx={{
                    transform: expanded ? 'rotate(180deg)' : 'none',
                    transition: 'transform 160ms ease',
                  }}
                />
              }
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
              sx={{ alignSelf: 'flex-start', minHeight: 44 }}
            >
              Status details
            </Button>
            <Collapse in={expanded}>
              <Stack spacing={0.5}>
                {policies.flatMap((policy) => (
                  policy.actualReadiness.blockerCodes.map((code) => (
                    <Typography
                      key={`${policy.resource}:${code}`}
                      variant="caption"
                      color="text.secondary"
                    >
                      {policy.resource === 'orders' ? 'Orders' : 'Inventory'}: {detail(code)}
                    </Typography>
                  ))
                ))}
              </Stack>
            </Collapse>
          </>
        ) : null}
      </Stack>
    </Paper>
  )
}
