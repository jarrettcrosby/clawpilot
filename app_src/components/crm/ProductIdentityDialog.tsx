'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import CallMergeRounded from '@mui/icons-material/CallMergeRounded'
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded'

type ProductIdentityRecord = {
  id: string
  globalId: string
  name: string
  sku: string | null
  sourceHash: string
  updatedAt: string
  providers: Array<'shopify' | 'faire'>
  mappingGlobalIds: string[]
  channelSkus: string[]
  barcodes: string[]
  packEvidence: {
    status: 'known' | 'unknown'
    profiles: Array<{
      profileGlobalId: string
      profileName: string
      packageLevel: 'each' | 'inner_pack' | 'case' | 'pallet'
      baseEachQuantity: number | null
      dimensionsMm: {
        length: number
        width: number
        height: number
      } | null
      dimensionBasis: 'inner' | 'outer' | 'unspecified' | null
      lifecycleState: string | null
      evidenceType: string | null
    }>
  }
  operationalReferenceCount: number
}

type ProductIdentitySuggestion = {
  key: string
  displayName: string
  confidence: 'identifier_match' | 'operator_review'
  evidenceType:
    | 'exact_sku'
    | 'exact_gtin'
    | 'exact_barcode'
    | 'operator_confirmed'
  evidenceValues: string[]
  canonical: ProductIdentityRecord
  duplicate: ProductIdentityRecord
  canApply: boolean
  blockers: string[]
}

type ProductIdentityResponse = {
  ok: boolean
  error?: string
  suggestions?: ProductIdentitySuggestion[]
  summary?: {
    total: number
    identifierMatches: number
    operatorReviews: number
    blocked: number
  }
}

function providerLabel(provider: 'shopify' | 'faire') {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function blockerLabel(code: string) {
  if (code === 'duplicate_has_operational_references') {
    return 'The duplicate owns inventory, order, packaging, or CRM relationships.'
  }
  if (code === 'conflicting_barcodes') {
    return 'The matching SKU points to conflicting current barcodes. Review the channel variants instead of combining these products.'
  }
  if (code === 'ambiguous_exact_identifier') {
    return 'This identifier belongs to more than one Shopify or Faire Product. Resolve the variant identities before combining products.'
  }
  return code.replaceAll('_', ' ')
}

function packLevelLabel(value: string) {
  return value.replaceAll('_', ' ')
}

function PackEvidence(props: {
  record: ProductIdentityRecord
}) {
  if (props.record.packEvidence.status === 'unknown') {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        Pack level, quantity, and dimensions are unknown.
      </Alert>
    )
  }
  return (
    <Stack spacing={0.5} mt={1}>
      {props.record.packEvidence.profiles.map((profile) => (
        <Typography
          key={profile.profileGlobalId}
          variant="caption"
          display="block"
        >
          {packLevelLabel(profile.packageLevel)}
          {' · '}
          {profile.baseEachQuantity
            ? `${profile.baseEachQuantity} base each`
            : 'quantity unknown'}
          {' · '}
          {profile.dimensionsMm
            ? `${profile.dimensionsMm.length} × ${
              profile.dimensionsMm.width
            } × ${profile.dimensionsMm.height} mm (${
              profile.dimensionBasis || 'basis unknown'
            })`
            : 'dimensions unknown'}
        </Typography>
      ))}
    </Stack>
  )
}

export default function ProductIdentityDialog(props: {
  open: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const [suggestions, setSuggestions] = useState<
    ProductIdentitySuggestion[]
  >([])
  const [summary, setSummary] =
    useState<ProductIdentityResponse['summary']>(undefined)
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/crm/product-identities', {
        cache: 'no-store',
      })
      const payload = await response.json() as ProductIdentityResponse
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Product identity review failed')
      }
      setSuggestions(payload.suggestions || [])
      setSummary(payload.summary)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Product identity review failed',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!props.open) return
    setConfirmed({})
    setNotice('')
    void load()
  }, [load, props.open])

  const actionableIdentifierMatches = useMemo(() => (
    suggestions.filter((suggestion) => (
      suggestion.canApply
      && suggestion.confidence === 'identifier_match'
    ))
  ), [suggestions])

  const applySuggestion = useCallback(async (
    suggestion: ProductIdentitySuggestion,
  ) => {
    setBusyKey(suggestion.key)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/crm/product-identities', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          canonicalGlobalId: suggestion.canonical.globalId,
          duplicateGlobalId: suggestion.duplicate.globalId,
          expectedCanonicalSourceHash: suggestion.canonical.sourceHash,
          expectedDuplicateSourceHash: suggestion.duplicate.sourceHash,
          expectedCanonicalUpdatedAt: suggestion.canonical.updatedAt,
          expectedDuplicateUpdatedAt: suggestion.duplicate.updatedAt,
          expectedCanonicalMappingGlobalIds:
            suggestion.canonical.mappingGlobalIds,
          expectedDuplicateMappingGlobalIds:
            suggestion.duplicate.mappingGlobalIds,
          evidenceType: suggestion.evidenceType,
          operatorConfirmed:
            suggestion.confidence === 'identifier_match'
            || confirmed[suggestion.key] === true,
        }),
      })
      const payload = await response.json() as {
        ok?: boolean
        error?: string
      }
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error || 'Product reconciliation failed')
      }
      setNotice(
        `${suggestion.displayName} now uses one product with both sales-channel listings.`,
      )
      await load()
      await props.onChanged()
      return true
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Product reconciliation failed',
      )
      return false
    } finally {
      setBusyKey(null)
    }
  }, [confirmed, load, props])

  const applyBatch = useCallback(async (
    selected: ProductIdentitySuggestion[],
  ) => {
    setBusyKey('__batch__')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/crm/product-identities', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirmBatch: true,
          items: selected.map((suggestion) => ({
            canonicalGlobalId: suggestion.canonical.globalId,
            duplicateGlobalId: suggestion.duplicate.globalId,
            expectedCanonicalSourceHash: suggestion.canonical.sourceHash,
            expectedDuplicateSourceHash: suggestion.duplicate.sourceHash,
            expectedCanonicalUpdatedAt: suggestion.canonical.updatedAt,
            expectedDuplicateUpdatedAt: suggestion.duplicate.updatedAt,
            expectedCanonicalMappingGlobalIds:
              suggestion.canonical.mappingGlobalIds,
            expectedDuplicateMappingGlobalIds:
              suggestion.duplicate.mappingGlobalIds,
            evidenceType: suggestion.evidenceType,
            operatorConfirmed: true,
          })),
        }),
      })
      const payload = await response.json() as {
        ok?: boolean
        error?: string
        result?: {
          applied?: number
          failed?: number
          errors?: Array<{ error?: string }>
        }
      }
      if (
        !response.ok
        && response.status !== 207
      ) {
        throw new Error(payload.error || 'Product reconciliation failed')
      }
      const applied = Number(payload.result?.applied || 0)
      const failed = Number(payload.result?.failed || 0)
      if (failed > 0) {
        setError(
          `${applied} products were combined; ${failed} changed or were blocked. ${
            payload.result?.errors?.[0]?.error || 'Reload and review them.'
          }`,
        )
      } else {
        setNotice(
          `${applied} products now carry their Shopify and Faire listings as added fields.`,
        )
      }
      await load()
      await props.onChanged()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Product reconciliation failed',
      )
    } finally {
      setBusyKey(null)
    }
  }, [load, props])

  return (
    <Dialog
      open={props.open}
      onClose={busyKey ? undefined : props.onClose}
      fullWidth
      maxWidth="md"
    >
      <DialogTitle>Resolve duplicate product identities</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="info">
            Keep one product for the sellable inventory and pack identity.
            Shopify and Faire remain separate, read-only sales-channel
            listings on that product. A different each, inner pack, or case
            remains a separate product.
          </Alert>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {notice ? (
            <Alert
              severity="success"
              icon={<CheckCircleOutlineRounded />}
            >
              {notice}
            </Alert>
          ) : null}
          {loading ? (
            <Stack
              minHeight={180}
              alignItems="center"
              justifyContent="center"
            >
              <CircularProgress size={28} />
            </Stack>
          ) : null}
          {!loading && summary ? (
            <Stack direction="row" gap={0.75} flexWrap="wrap">
              <Chip label={`${summary.total} suggestions`} />
              <Chip
                color="success"
                variant="outlined"
                label={`${summary.identifierMatches} identifier matches`}
              />
              <Chip
                color="warning"
                variant="outlined"
                label={`${summary.operatorReviews} need confirmation`}
              />
              {summary.blocked > 0 ? (
                <Chip
                  color="error"
                  variant="outlined"
                  label={`${summary.blocked} blocked`}
                />
              ) : null}
            </Stack>
          ) : null}
          {!loading && actionableIdentifierMatches.length > 1 ? (
            <Box>
              <Button
                variant="contained"
                startIcon={<CallMergeRounded />}
                disabled={Boolean(busyKey)}
                onClick={() => void applyBatch(
                  actionableIdentifierMatches,
                )}
              >
                Combine {actionableIdentifierMatches.length} verified matches
              </Button>
            </Box>
          ) : null}
          {!loading && suggestions.length === 0 && !error ? (
            <Alert severity="success">
              No duplicate Shopify/Faire product identities need review.
            </Alert>
          ) : null}
          {!loading && suggestions.map((suggestion) => {
            const needsConfirmation =
              suggestion.confidence === 'operator_review'
            const canSubmit = suggestion.canApply && (
              !needsConfirmation || confirmed[suggestion.key] === true
            )
            return (
              <Box
                key={suggestion.key}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1.5,
                  p: 1.5,
                }}
              >
                <Stack spacing={1.25}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    gap={1}
                    justifyContent="space-between"
                    alignItems={{ xs: 'flex-start', sm: 'center' }}
                  >
                    <Box>
                      <Typography fontWeight={700}>
                        {suggestion.displayName}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                      >
                        {suggestion.confidence === 'identifier_match'
                          ? `Verified by ${
                            suggestion.evidenceType === 'exact_sku'
                              ? 'matching SKU'
                              : suggestion.evidenceType === 'exact_gtin'
                                ? 'matching GTIN'
                                : 'matching barcode'
                          }`
                          : 'Names match; product and pack identity need confirmation'}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      color={suggestion.confidence === 'identifier_match'
                        ? 'success'
                        : 'warning'}
                      label={suggestion.confidence === 'identifier_match'
                        ? 'Identifier match'
                        : 'Review required'}
                    />
                  </Stack>
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    gap={1}
                  >
                    <Box
                      sx={{
                        flex: 1,
                        border: '1px solid',
                        borderColor: 'success.main',
                        borderRadius: 1,
                        p: 1.25,
                      }}
                    >
                      <Typography
                        variant="overline"
                        color="success.main"
                      >
                        Keep as canonical
                      </Typography>
                      <Typography fontWeight={600}>
                        {suggestion.canonical.name}
                      </Typography>
                      <Typography variant="caption" display="block">
                        {suggestion.canonical.globalId}
                        {suggestion.canonical.sku
                          ? ` · SKU ${suggestion.canonical.sku}`
                          : ''}
                      </Typography>
                      <Stack
                        direction="row"
                        gap={0.5}
                        mt={0.75}
                        flexWrap="wrap"
                      >
                        {suggestion.canonical.providers.map((provider) => (
                          <Chip
                            key={provider}
                            size="small"
                            label={providerLabel(provider)}
                          />
                        ))}
                        {suggestion.canonical.operationalReferenceCount > 0
                          ? (
                            <Chip
                              size="small"
                              variant="outlined"
                              label="Owns operational data"
                            />
                          )
                          : null}
                      </Stack>
                      <PackEvidence record={suggestion.canonical} />
                    </Box>
                    <Box
                      sx={{
                        flex: 1,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        p: 1.25,
                      }}
                    >
                      <Typography variant="overline">
                        Retain as historical alias
                      </Typography>
                      <Typography fontWeight={600}>
                        {suggestion.duplicate.name}
                      </Typography>
                      <Typography variant="caption" display="block">
                        {suggestion.duplicate.globalId}
                        {suggestion.duplicate.sku
                          ? ` · SKU ${suggestion.duplicate.sku}`
                          : ''}
                      </Typography>
                      <Stack
                        direction="row"
                        gap={0.5}
                        mt={0.75}
                        flexWrap="wrap"
                      >
                        {suggestion.duplicate.providers.map((provider) => (
                          <Chip
                            key={provider}
                            size="small"
                            label={providerLabel(provider)}
                          />
                        ))}
                      </Stack>
                      <PackEvidence record={suggestion.duplicate} />
                    </Box>
                  </Stack>
                  {suggestion.evidenceValues.length > 0 ? (
                    <Typography variant="caption">
                      Matching identifier: {
                        suggestion.evidenceValues.join(', ')
                      }
                    </Typography>
                  ) : null}
                  {suggestion.blockers.map((blocker) => (
                    <Alert key={blocker} severity="error">
                      {blockerLabel(blocker)}
                    </Alert>
                  ))}
                  {needsConfirmation && suggestion.canApply ? (
                    <FormControlLabel
                      control={(
                        <Checkbox
                          checked={confirmed[suggestion.key] === true}
                          onChange={(event) => setConfirmed((current) => ({
                            ...current,
                            [suggestion.key]: event.target.checked,
                          }))}
                        />
                      )}
                      label="I confirmed these are the same sellable product and the same pack level."
                    />
                  ) : null}
                  <Box>
                    <Button
                      variant="outlined"
                      startIcon={busyKey === suggestion.key
                        ? <CircularProgress size={16} />
                        : <CallMergeRounded />}
                      disabled={!canSubmit || Boolean(busyKey)}
                      onClick={() => void applySuggestion(suggestion)}
                    >
                      Combine channel listings
                    </Button>
                  </Box>
                </Stack>
              </Box>
            )
          })}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={Boolean(busyKey)} onClick={props.onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}
