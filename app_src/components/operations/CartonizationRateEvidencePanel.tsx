'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import ScienceRounded from '@mui/icons-material/ScienceRounded'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import { formatDimensionsMm, formatGrams } from '@/lib/measurements'

type EvidenceAllocation = {
  lineGlobalId: string
  productGlobalId: string
  title: string
  quantity: number
}

type EvidenceRate = {
  serviceCode: string
  serviceName: string
  amount: string
  currency: string
  rateType: string | null
  transitDays: number | null
  deliveryDate: string | null
}

type EvidenceQuote = {
  provider: 'ups_rest' | 'fedex_rest'
  rateEvidenceGlobalId: string
  status: 'succeeded' | 'failed'
  errorCode: string | null
  carrierRequestHash: string
  packageRateContextHash: string
  rates: EvidenceRate[]
  requestedAt: string
  completedAt: string
}

type EvidencePackage = {
  packageKey: string
  packageSequence: number
  planningMethod: 'approved_recipe' | 'or_tools'
  packagingMaterialGlobalId: string
  packagingMaterialName: string
  approvedPackRecipeGlobalId: string | null
  approvedPackRecipeName: string | null
  materialRowVersion: number
  recipeRowVersion: number | null
  recipes: Array<{
    recipeGlobalId: string
    recipeName: string
    productGlobalId: string
    inputProfileVersionGlobalId: string
    recipeRowVersion: number
    inputProfileVersionRowVersion: number
  }>
  innerDimensionsMm: {
    length: number
    width: number
    height: number
  }
  ratedOuterDimensionsMm: {
    length: number
    width: number
    height: number
  }
  contentWeightGrams: number
  tareWeightGrams: number
  ratedGrossWeightGrams: number
  maxWeightGrams: number | null
  allocations: EvidenceAllocation[]
  carrierParcel: {
    description: string
    length: number
    width: number
    height: number
    dimensionUnit: 'IN'
    weight: number
    weightUnit: 'LB'
  }
  packageHash: string
  quotes: EvidenceQuote[]
}

type CartonizationRateEvidence = {
  globalId: string
  accountGlobalId: string
  candidateGlobalId: string
  candidateOrderNumber: string
  candidateRowVersion: number
  candidateSourceHash: string
  destinationFingerprint: string
  requestHash: string
  warehouse: {
    globalId: string
    name: string
  }
  inventorySyncRunGlobalId: string | null
  evidenceMode: 'operational' | 'assumption_backed_sandbox'
  policyVersion: string
  algorithmVersion: string
  planInputHash: string
  planResultHash: string
  planSnapshot: Record<string, unknown>
  assumptionSnapshot: Record<string, unknown>
  status: 'succeeded' | 'partial' | 'failed'
  idempotencyKey: string
  actorEmail: string | null
  createdAt: string
  packages: EvidencePackage[]
}

type EvidencePayload = {
  ok?: boolean
  error?: string
  code?: string
  evidence?: CartonizationRateEvidence
}

type Props = {
  evidenceGlobalId: string
}

type AssumptionLine = {
  label: string
  value: string
}

const referenceSx = {
  fontFamily: 'monospace',
  overflowWrap: 'anywhere',
}

function providerLabel(provider: EvidenceQuote['provider']) {
  return provider === 'ups_rest' ? 'UPS' : 'FedEx'
}

function planningMethodLabel(
  method: EvidencePackage['planningMethod'],
) {
  return method === 'approved_recipe'
    ? 'Customer-approved pack recipe'
    : 'OR-Tools geometry'
}

function formatTimestamp(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

function formatRate(rate: EvidenceRate) {
  const amount = Number(rate.amount)
  if (!Number.isFinite(amount)) return `${rate.amount} ${rate.currency}`
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: rate.currency,
    }).format(amount)
  } catch {
    return `${rate.amount} ${rate.currency}`
  }
}

function sentenceLabel(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function assumptionLines(
  snapshot: Record<string, unknown>,
): AssumptionLine[] {
  const result: AssumptionLine[] = []
  const visit = (value: unknown, path: string) => {
    if (value === null || value === undefined) {
      result.push({ label: sentenceLabel(path), value: 'None' })
      return
    }
    if (typeof value === 'boolean') {
      result.push({
        label: sentenceLabel(path),
        value: value ? 'Yes' : 'No',
      })
      return
    }
    if (typeof value === 'string' || typeof value === 'number') {
      result.push({
        label: sentenceLabel(path),
        value: String(value),
      })
      return
    }
    if (Array.isArray(value)) {
      if (!value.length) {
        result.push({ label: sentenceLabel(path), value: 'None' })
        return
      }
      if (value.every((entry) => (
        typeof entry === 'string' || typeof entry === 'number'
      ))) {
        result.push({
          label: sentenceLabel(path),
          value: value.join(', '),
        })
        return
      }
      value.forEach((entry, index) => {
        visit(entry, `${path} ${index + 1}`)
      })
      return
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value)
      if (!entries.length) {
        result.push({ label: sentenceLabel(path), value: 'None' })
        return
      }
      entries.forEach(([key, entry]) => {
        visit(entry, path ? `${path} ${key}` : key)
      })
      return
    }
    result.push({ label: sentenceLabel(path), value: 'Unavailable' })
  }

  Object.entries(snapshot).forEach(([key, value]) => visit(value, key))
  return result
}

function statusColor(
  status: CartonizationRateEvidence['status'],
): 'success' | 'warning' | 'error' {
  if (status === 'succeeded') return 'success'
  if (status === 'partial') return 'warning'
  return 'error'
}

export default function CartonizationRateEvidencePanel({
  evidenceGlobalId,
}: Props) {
  const { measurementSystem } = useMeasurementSystem()
  const [payload, setPayload] = useState<EvidencePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadRevision, setReloadRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const parameters = new URLSearchParams({ evidenceGlobalId })

    fetch(
      `/api/integrations/commerce/intake/cartonization-rate-evidence?${parameters}`,
      {
        cache: 'no-store',
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const next = await response.json() as EvidencePayload
        if (!response.ok || !next.evidence) {
          throw new Error(
            next.error
            || 'Cartonization and carrier-rate evidence is unavailable.',
          )
        }
        return next
      })
      .then((next) => {
        setPayload(next)
        setError('')
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          return
        }
        setPayload(null)
        setError(
          caught instanceof Error
            ? caught.message
            : 'Cartonization and carrier-rate evidence is unavailable.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [evidenceGlobalId, reloadRevision])

  const evidence = payload?.evidence
  const assumptions = useMemo(
    () => assumptionLines(evidence?.assumptionSnapshot || {}),
    [evidence?.assumptionSnapshot],
  )

  return (
    <Paper
      variant="outlined"
      sx={{
        p: { xs: 1.5, md: 2 },
        borderColor: 'rgba(255, 183, 77, 0.4)',
        background:
          'linear-gradient(135deg, rgba(255,183,77,0.08), rgba(21,21,29,0.94) 42%)',
      }}
    >
      <Stack spacing={2}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'stretch', sm: 'flex-start' }}
          gap={1.5}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <ScienceRounded color="warning" />
              <Typography variant="h6" fontWeight={800}>
                Pack optimization and carrier-rate evidence
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Reloadable evidence joins one exact order candidate to its
              carton plan and read-only UPS and FedEx rate responses.
            </Typography>
          </Box>
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshRounded />}
            disabled={loading}
            onClick={() => {
              setLoading(true)
              setError('')
              setReloadRevision((revision) => revision + 1)
            }}
          >
            Reload evidence
          </Button>
        </Stack>

        {loading && !evidence ? (
          <Box sx={{ minHeight: 160, display: 'grid', placeItems: 'center' }}>
            <CircularProgress size={30} />
          </Box>
        ) : null}

        {error ? <Alert severity="error">{error}</Alert> : null}

        {evidence ? (
          <>
            {evidence.evidenceMode === 'assumption_backed_sandbox' ? (
              <Alert
                severity="warning"
                variant="filled"
                sx={{
                  '& .MuiAlert-message': { width: '100%' },
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  fontWeight: 900,
                }}
              >
                Assumption-backed sandbox proof — not a production shipment
              </Alert>
            ) : (
              <Alert severity="success">
                Operational evidence — no sandbox-only assumptions recorded.
              </Alert>
            )}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                color={statusColor(evidence.status)}
                label={sentenceLabel(evidence.status)}
              />
              <Chip
                size="small"
                variant="outlined"
                label={`${evidence.packages.length} package${evidence.packages.length === 1 ? '' : 's'}`}
              />
              <Chip
                size="small"
                variant="outlined"
                label={`Warehouse: ${evidence.warehouse.name}`}
              />
              <Chip
                size="small"
                variant="outlined"
                label={formatTimestamp(evidence.createdAt)}
              />
            </Stack>

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: {
                  xs: '1fr',
                  md: 'repeat(3, minmax(0, 1fr))',
                },
                gap: 1.25,
              }}
            >
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Evidence / order
                </Typography>
                <Typography fontWeight={800} sx={referenceSx}>
                  {evidence.globalId}
                </Typography>
                <Typography variant="body2">
                  Order {evidence.candidateOrderNumber}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Candidate / sales channel
                </Typography>
                <Typography variant="body2" sx={referenceSx}>
                  {evidence.candidateGlobalId}
                </Typography>
                <Typography variant="body2" sx={referenceSx}>
                  {evidence.accountGlobalId}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Exact planning versions
                </Typography>
                <Typography variant="body2">
                  Policy {evidence.policyVersion}
                </Typography>
                <Typography variant="body2">
                  Algorithm {evidence.algorithmVersion}
                </Typography>
              </Box>
            </Box>

            {evidence.evidenceMode === 'assumption_backed_sandbox' ? (
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  border: '1px dashed rgba(255,183,77,0.55)',
                }}
              >
                <Typography fontWeight={800}>
                  Explicit sandbox assumptions
                </Typography>
                {assumptions.length ? (
                  <Stack
                    component="dl"
                    spacing={0.75}
                    divider={<Divider flexItem />}
                    sx={{ m: 0, mt: 1 }}
                  >
                    {assumptions.map((assumption, index) => (
                      <Box
                        key={`${assumption.label}:${index}`}
                        sx={{
                          py: 0.5,
                          display: 'grid',
                          gridTemplateColumns: {
                            xs: '1fr',
                            sm: 'minmax(160px, 0.35fr) minmax(0, 1fr)',
                          },
                          gap: 1,
                        }}
                      >
                        <Typography
                          component="dt"
                          variant="body2"
                          color="text.secondary"
                        >
                          {assumption.label}
                        </Typography>
                        <Typography
                          component="dd"
                          variant="body2"
                          sx={{ m: 0, overflowWrap: 'anywhere' }}
                        >
                          {assumption.value}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    The evidence is marked assumption-backed; no additional
                    structured assumption fields were returned.
                  </Typography>
                )}
              </Box>
            ) : null}

            <Stack spacing={2}>
              {evidence.packages.map((item) => (
                <Paper
                  key={item.packageKey}
                  variant="outlined"
                  sx={{ p: { xs: 1.25, md: 1.75 } }}
                >
                  <Stack spacing={1.5}>
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      justifyContent="space-between"
                      alignItems={{ xs: 'flex-start', sm: 'center' }}
                      gap={1}
                    >
                      <Box>
                        <Typography fontWeight={800}>
                          Package {item.packageSequence}: {item.packagingMaterialName}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={referenceSx}
                        >
                          {item.packageKey} · {item.packagingMaterialGlobalId}
                        </Typography>
                      </Box>
                      <Chip
                        size="small"
                        color={item.planningMethod === 'approved_recipe'
                          ? 'info'
                          : 'secondary'}
                        variant="outlined"
                        label={planningMethodLabel(item.planningMethod)}
                      />
                    </Stack>

                    {item.planningMethod === 'approved_recipe' ? (
                      <Alert severity="info">
                        <Typography variant="body2" fontWeight={800}>
                          {item.recipes.length} approved recipe
                          {item.recipes.length === 1 ? '' : 's'} retained
                        </Typography>
                        {item.recipes.map((recipe) => (
                          <Typography
                            key={recipe.recipeGlobalId}
                            variant="body2"
                            sx={referenceSx}
                          >
                            {recipe.recipeName} · {recipe.recipeGlobalId}
                            {' · '}
                            {recipe.productGlobalId}
                          </Typography>
                        ))}
                      </Alert>
                    ) : (
                      <Alert severity="info">
                        Rigid item placement was solved with the recorded
                        OR-Tools geometry plan.
                      </Alert>
                    )}

                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: {
                          xs: '1fr',
                          sm: 'repeat(2, minmax(0, 1fr))',
                          lg: 'repeat(4, minmax(0, 1fr))',
                        },
                        gap: 1,
                      }}
                    >
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Stored customer material dimensions
                        </Typography>
                        <Typography fontWeight={700}>
                          {formatDimensionsMm({
                            lengthMm: item.innerDimensionsMm.length,
                            widthMm: item.innerDimensionsMm.width,
                            heightMm: item.innerDimensionsMm.height,
                          }, measurementSystem, {
                            maximumFractionDigits: 3,
                          })}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Carrier-rated exterior
                        </Typography>
                        <Typography fontWeight={700}>
                          {formatDimensionsMm({
                            lengthMm: item.ratedOuterDimensionsMm.length,
                            widthMm: item.ratedOuterDimensionsMm.width,
                            heightMm: item.ratedOuterDimensionsMm.height,
                          }, measurementSystem, {
                            maximumFractionDigits: 3,
                          })}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Exact request: {item.carrierParcel.length} ×{' '}
                          {item.carrierParcel.width} ×{' '}
                          {item.carrierParcel.height}{' '}
                          {item.carrierParcel.dimensionUnit} ·{' '}
                          {item.carrierParcel.weight}{' '}
                          {item.carrierParcel.weightUnit}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Content + tare
                        </Typography>
                        <Typography fontWeight={700}>
                          {formatGrams(item.contentWeightGrams, measurementSystem, {
                            maximumFractionDigits: 3,
                          })}
                          {' + '}
                          {formatGrams(item.tareWeightGrams, measurementSystem, {
                            maximumFractionDigits: 3,
                          })}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Rated gross weight
                        </Typography>
                        <Typography fontWeight={700}>
                          {formatGrams(item.ratedGrossWeightGrams, measurementSystem, {
                            maximumFractionDigits: 3,
                          })}
                        </Typography>
                        {item.maxWeightGrams !== null ? (
                          <Typography variant="caption" color="text.secondary">
                            Material limit{' '}
                            {formatGrams(item.maxWeightGrams, measurementSystem, {
                              maximumFractionDigits: 3,
                            })}
                          </Typography>
                        ) : null}
                      </Box>
                    </Box>

                    <Box>
                      <Typography variant="subtitle2" fontWeight={800}>
                        Exact package allocation
                      </Typography>
                      <Stack
                        divider={<Divider flexItem />}
                        sx={{ mt: 0.5 }}
                      >
                        {item.allocations.map((allocation) => (
                          <Box
                            key={`${allocation.lineGlobalId}:${allocation.productGlobalId}`}
                            sx={{
                              py: 0.75,
                              display: 'grid',
                              gridTemplateColumns: 'minmax(0, 1fr) auto',
                              gap: 1,
                            }}
                          >
                            <Box sx={{ minWidth: 0 }}>
                              <Typography variant="body2" fontWeight={650}>
                                {allocation.title}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={referenceSx}
                              >
                                {allocation.lineGlobalId} · {allocation.productGlobalId}
                              </Typography>
                            </Box>
                            <Typography fontWeight={800}>
                              × {allocation.quantity}
                            </Typography>
                          </Box>
                        ))}
                      </Stack>
                    </Box>

                    <Box>
                      <Typography variant="subtitle2" fontWeight={800} gutterBottom>
                        UPS and FedEx sandbox quote matrix
                      </Typography>
                      <TableContainer component={Paper} variant="outlined">
                        <Table size="small" aria-label={`Carrier rates for package ${item.packageSequence}`}>
                          <TableHead>
                            <TableRow>
                              <TableCell>Carrier</TableCell>
                              <TableCell>Service</TableCell>
                              <TableCell align="right">Rate</TableCell>
                              <TableCell>Transit</TableCell>
                              <TableCell>Rate evidence</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {item.quotes.flatMap((quote) => {
                              if (
                                quote.status === 'failed'
                                || quote.rates.length === 0
                              ) {
                                return [(
                                  <TableRow key={`${quote.provider}:failed`}>
                                    <TableCell>
                                      {providerLabel(quote.provider)}
                                    </TableCell>
                                    <TableCell colSpan={3}>
                                      <Chip
                                        size="small"
                                        color="error"
                                        label={quote.errorCode
                                          ? `Failed: ${quote.errorCode}`
                                          : 'No rates returned'}
                                      />
                                    </TableCell>
                                    <TableCell sx={referenceSx}>
                                      {quote.rateEvidenceGlobalId}
                                    </TableCell>
                                  </TableRow>
                                )]
                              }
                              return quote.rates.map((rate) => (
                                <TableRow
                                  key={`${quote.provider}:${rate.serviceCode}:${rate.amount}:${rate.rateType || ''}`}
                                >
                                  <TableCell>
                                    {providerLabel(quote.provider)}
                                  </TableCell>
                                  <TableCell>
                                    <Typography variant="body2" fontWeight={650}>
                                      {rate.serviceName}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                      {rate.serviceCode}
                                      {rate.rateType ? ` · ${rate.rateType}` : ''}
                                    </Typography>
                                  </TableCell>
                                  <TableCell align="right">
                                    {formatRate(rate)}
                                  </TableCell>
                                  <TableCell>
                                    {rate.transitDays === null
                                      ? 'Not supplied'
                                      : `${rate.transitDays} day${rate.transitDays === 1 ? '' : 's'}`}
                                    {rate.deliveryDate
                                      ? ` · ${rate.deliveryDate}`
                                      : ''}
                                  </TableCell>
                                  <TableCell sx={referenceSx}>
                                    {quote.rateEvidenceGlobalId}
                                  </TableCell>
                                </TableRow>
                              ))
                            })}
                            {item.quotes.length === 0 ? (
                              <TableRow>
                                <TableCell colSpan={5}>
                                  No carrier quote evidence is attached.
                                </TableCell>
                              </TableRow>
                            ) : null}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </Box>
                  </Stack>
                </Paper>
              ))}
            </Stack>

            <Divider />

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: {
                  xs: '1fr',
                  md: 'repeat(3, minmax(0, 1fr))',
                },
                gap: 1,
              }}
            >
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Candidate source hash / row version
                </Typography>
                <Typography variant="body2" sx={referenceSx}>
                  {evidence.candidateSourceHash} · v{evidence.candidateRowVersion}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Plan input / result hashes
                </Typography>
                <Typography variant="body2" sx={referenceSx}>
                  {evidence.planInputHash}
                </Typography>
                <Typography variant="body2" sx={referenceSx}>
                  {evidence.planResultHash}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Destination / semantic request hashes
                </Typography>
                <Typography variant="body2" sx={referenceSx}>
                  {evidence.destinationFingerprint}
                </Typography>
                <Typography variant="body2" sx={referenceSx}>
                  {evidence.requestHash}
                </Typography>
              </Box>
            </Box>
          </>
        ) : null}
      </Stack>
    </Paper>
  )
}
