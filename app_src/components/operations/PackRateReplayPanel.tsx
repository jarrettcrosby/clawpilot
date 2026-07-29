'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import LockRounded from '@mui/icons-material/LockRounded'
import PersonSearchRounded from '@mui/icons-material/PersonSearchRounded'
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded'
import PrintRounded from '@mui/icons-material/PrintRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import ShoppingCartCheckoutRounded from '@mui/icons-material/ShoppingCartCheckoutRounded'
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatDimensionsMm, formatGrams } from '@/lib/measurements'
import type {
  OperationsRegressionPackage,
  OperationsRegressionPackRateStage,
  OperationsRegressionRun,
  OperationsRegressionScenario,
  OperationsRegressionStageStatus,
  OperationsRegressionWalkthrough,
} from '@/lib/operations/regressionReplay'
import { formatUserDateTime } from '@/lib/userDateTime'

type ReplayGate = {
  code: string
  label: string
  status: OperationsRegressionStageStatus
  detail: string
}

type ReplayPayload = {
  ok?: boolean
  error?: string
  code?: string
  walkthrough?: OperationsRegressionWalkthrough
  run?: OperationsRegressionRun
}

const endpoint = '/api/operations/regression-replays'

const referenceSx = {
  fontFamily: 'monospace',
  overflowWrap: 'anywhere',
}

function providerLabel(provider: OperationsRegressionScenario['provider']) {
  return provider === 'shopify' ? 'Shopify' : 'Faire'
}

function displayCode(value: string) {
  return value
    .replace(/[_.-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function formatMoney(minor: number | null, currency: string) {
  if (minor === null) return 'Not captured'
  const amount = Number(minor) / 100
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(Number.isFinite(amount) ? amount : 0)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

function stageColor(
  status: OperationsRegressionStageStatus | OperationsRegressionRun['status'],
): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (status === 'passed' || status === 'succeeded') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'warning' || status === 'expected_blocked') return 'warning'
  return 'default'
}

function carrierMatchesSelectedRate(
  carrier: string | null,
  provider: OperationsRegressionPackRateStage['selectedRate']['provider'],
) {
  const normalizedCarrier = (carrier || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  return provider === 'ups_rest'
    ? normalizedCarrier === 'ups' || normalizedCarrier === 'upsrest'
    : normalizedCarrier === 'fedex' || normalizedCarrier === 'fedexrest'
}

function singleServiceGate(run: OperationsRegressionRun): ReplayGate {
  const stage = run.stages.fulfillmentExecution
  if (!stage) {
    return {
      code: 'single_service',
      label: 'One service applies to every package',
      status: 'warning',
      detail: 'Fulfillment did not run, so no selected-rate or label evidence exists.',
    }
  }

  const selectedChoices = stage.rateChoices.filter((rate) => rate.selected)
  const selectedRate = stage.selectedRate
  const selectedRateIsPersisted = (
    selectedChoices.length === 1
    && selectedChoices[0].provider === selectedRate.provider
    && selectedChoices[0].serviceCode === selectedRate.serviceCode
    && selectedChoices[0].recordedFactVersion === selectedRate.recordedFactVersion
    && selectedChoices[0].carrierCostMinor === selectedRate.carrierCostMinor
    && stage.selectedCarrierCostMinor === selectedRate.carrierCostMinor
  )
  if (!selectedRateIsPersisted) {
    return {
      code: 'single_service',
      label: 'One service applies to every package',
      status: 'failed',
      detail: 'Persisted selected-rate evidence is missing or conflicts with the recorded choices.',
    }
  }

  const expectedPackageKeys = new Set(stage.packages.map((item) => item.packageKey))
  const labelPackages = run.stages.labelFinalization.packages
  const recordedLabelPackageKeys = new Set(labelPackages.map((item) => item.packageKey))
  const packageSetMatches = (
    stage.packageCount > 0
    && stage.packages.length === stage.packageCount
    && expectedPackageKeys.size === stage.packageCount
    && labelPackages.length === stage.packageCount
    && recordedLabelPackageKeys.size === stage.packageCount
    && labelPackages.every((item) => expectedPackageKeys.has(item.packageKey))
  )
  if (!packageSetMatches) {
    return {
      code: 'single_service',
      label: 'One service applies to every package',
      status: 'failed',
      detail: 'The persisted label package set does not match the fulfillment package plan.',
    }
  }

  const finalizedPackages = labelPackages.filter((item) => item.status === 'finalized')
  const packageWithoutLabelEvidence = finalizedPackages.find(
    (item) => !item.recordedLabelReference,
  )
  if (packageWithoutLabelEvidence) {
    return {
      code: 'single_service',
      label: 'One service applies to every package',
      status: 'failed',
      detail: `Package ${packageWithoutLabelEvidence.sequence} is finalized without a persisted label reference.`,
    }
  }

  const mismatchedPackage = finalizedPackages.find((item) => (
    item.serviceCode !== selectedRate.serviceCode
    || !carrierMatchesSelectedRate(item.carrier, selectedRate.provider)
  ))
  if (mismatchedPackage) {
    return {
      code: 'single_service',
      label: 'One service applies to every package',
      status: 'failed',
      detail: `Package ${mismatchedPackage.sequence} label evidence conflicts with ${selectedRate.serviceName}.`,
    }
  }

  if (finalizedPackages.length !== stage.packageCount) {
    return {
      code: 'single_service',
      label: 'One service applies to every package',
      status: 'warning',
      detail: `${selectedRate.serviceName} is selected for ${stage.packageCount} packages, but recorded label finalization has not proven every package used it.`,
    }
  }

  return {
    code: 'single_service',
    label: 'One service applies to every package',
    status: 'passed',
    detail: `Recorded labels prove ${selectedRate.serviceName} was applied to all ${stage.packageCount} packages.`,
  }
}

function StageShell({
  sequence,
  title,
  icon,
  status,
  summary,
  gates = [],
  evidenceReferences = [],
  children,
}: {
  sequence: number
  title: string
  icon: React.ReactNode
  status: OperationsRegressionStageStatus
  summary: string
  gates?: ReplayGate[]
  evidenceReferences?: string[]
  children: React.ReactNode
}) {
  return (
    <Paper
      component="section"
      variant="outlined"
      sx={{ p: { xs: 1.5, sm: 2 }, borderColor: 'rgba(255,255,255,0.1)' }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
          <Box
            sx={{
              width: 34,
              height: 34,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '8px',
              color: '#A8C7FA',
              backgroundColor: 'rgba(126,171,255,0.12)',
              flexShrink: 0,
            }}
          >
            {icon}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">
              Stage {sequence}
            </Typography>
            <Typography component="h3" fontWeight={700}>{title}</Typography>
          </Box>
        </Stack>
        <Chip
          size="small"
          variant="outlined"
          color={stageColor(status)}
          label={displayCode(status)}
        />
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25 }}>
        {summary}
      </Typography>
      <Box sx={{ mt: 1.5 }}>{children}</Box>

      {gates.length > 0 && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="overline" color="text.secondary">Lifecycle gates</Typography>
          <Stack spacing={0.75} sx={{ mt: 0.5 }}>
            {gates.map((gate) => (
              <Stack
                key={gate.code}
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent="space-between"
                gap={0.5}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={600}>{gate.label}</Typography>
                  <Typography variant="caption" color="text.secondary">{gate.detail}</Typography>
                </Box>
                <Chip
                  size="small"
                  variant="outlined"
                  color={stageColor(gate.status)}
                  label={displayCode(gate.status)}
                  sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}
                />
              </Stack>
            ))}
          </Stack>
        </>
      )}

      {evidenceReferences.length > 0 && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
          Evidence: {evidenceReferences.join(' · ')}
        </Typography>
      )}
    </Paper>
  )
}

function PackageCards({ packages }: { packages: OperationsRegressionPackage[] }) {
  const measurementSystem = useMeasurementSystem()

  if (packages.length === 0) {
    return (
      <Alert severity="warning">
        No package allocation is recorded for this pass.
      </Alert>
    )
  }

  return (
    <Stack spacing={1}>
      {packages.map((item) => (
        <Paper
          key={item.packageKey}
          variant="outlined"
          sx={{ p: 1.25, backgroundColor: 'rgba(255,255,255,0.015)' }}
        >
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            gap={0.75}
          >
            <Box>
              <Typography fontWeight={700}>
                Package {item.sequence} · {item.materialName}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={referenceSx}>
                {item.packageKey}
              </Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">
              {formatDimensionsMm({
                lengthMm: item.dimensionsMm.length,
                widthMm: item.dimensionsMm.width,
                heightMm: item.dimensionsMm.height,
              }, measurementSystem.measurementSystem)}
              {' · '}
              {formatGrams(item.grossWeightGrams, measurementSystem.measurementSystem)}
            </Typography>
          </Stack>
          <TableContainer sx={{ mt: 1 }}>
            <Table size="small" aria-label={`Package ${item.sequence} contents`}>
              <TableHead>
                <TableRow>
                  <TableCell>Product ref</TableCell>
                  <TableCell>Product</TableCell>
                  <TableCell align="right">Units</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {item.allocations.map((content) => (
                  <TableRow key={`${item.packageKey}:${content.lineKey}:${content.productKey}`}>
                    <TableCell sx={referenceSx}>{content.productKey}</TableCell>
                    <TableCell>
                      <Typography variant="body2">{content.title}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={referenceSx}>
                        {content.lineKey}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{content.quantity}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      ))}
    </Stack>
  )
}

function RateChoices({ stage }: { stage: OperationsRegressionPackRateStage }) {
  return (
    <TableContainer>
      <Table size="small" aria-label={`${displayCode(stage.purpose)} recorded carrier rates`}>
        <TableHead>
          <TableRow>
            <TableCell>Carrier</TableCell>
            <TableCell>Service</TableCell>
            <TableCell align="right">Packages</TableCell>
            <TableCell align="right">Recorded cost</TableCell>
            <TableCell>Selection</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {stage.rateChoices.map((rate) => (
            <TableRow
              key={`${stage.runGlobalId}:${rate.provider}:${rate.serviceCode}`}
              selected={rate.selected}
            >
              <TableCell>{rate.provider === 'ups_rest' ? 'UPS' : 'FedEx'}</TableCell>
              <TableCell>
                <Typography variant="body2">{rate.serviceName}</Typography>
                <Typography variant="caption" color="text.secondary" sx={referenceSx}>
                  {rate.serviceCode}
                </Typography>
              </TableCell>
              <TableCell align="right">{stage.packageCount}</TableCell>
              <TableCell align="right">
                {formatMoney(rate.carrierCostMinor, rate.currency)}
              </TableCell>
              <TableCell>
                <Chip
                  size="small"
                  variant="outlined"
                  color={rate.selected ? 'success' : 'default'}
                  label={rate.selected ? 'Selected' : 'Compared'}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

export default function PackRateReplayPanel() {
  const dateTime = useUserDateTime()
  const [walkthrough, setWalkthrough] =
    useState<OperationsRegressionWalkthrough | null>(null)
  const [scenarioId, setScenarioId] = useState('')
  const [selectedRunGlobalId, setSelectedRunGlobalId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (
    preferredRunGlobalId?: string | null,
    signal?: AbortSignal,
  ) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal })
      const payload = await response.json() as ReplayPayload
      if (!response.ok || !payload.walkthrough) {
        throw new Error(payload.error || 'Replay evidence is unavailable')
      }
      setWalkthrough(payload.walkthrough)
      const preferredRun = (
        payload.walkthrough.runs.find((run) => run.globalId === preferredRunGlobalId)
        || payload.walkthrough.runs[0]
        || null
      )
      setScenarioId((current) => (
        preferredRun
        && payload.walkthrough?.scenarios.some(
          (scenario) => scenario.id === preferredRun.scenarioId,
        )
          ? preferredRun.scenarioId
          : payload.walkthrough?.scenarios.some((scenario) => scenario.id === current)
            ? current
            : payload.walkthrough?.scenarios[0]?.id || ''
      ))
      setSelectedRunGlobalId(preferredRun?.globalId || null)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'Replay evidence is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(null, controller.signal)
    return () => controller.abort()
  }, [load])

  const selectedScenario = useMemo(
    () => walkthrough?.scenarios.find((scenario) => scenario.id === scenarioId) || null,
    [scenarioId, walkthrough?.scenarios],
  )
  const selectedRun = useMemo(
    () => walkthrough?.runs.find((run) => run.globalId === selectedRunGlobalId) || null,
    [selectedRunGlobalId, walkthrough?.runs],
  )

  const runReplay = async () => {
    if (!scenarioId || running) return
    setRunning(true)
    setError('')
    setNotice('')
    const idempotencyKey = `operations-regression-replay:${scenarioId}:${crypto.randomUUID()}`
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          action: 'run-replay',
          scenarioId,
          idempotencyKey,
        }),
      })
      const payload = await response.json() as ReplayPayload
      if (!response.ok || !payload.run) {
        throw new Error(payload.error || 'Historical replay could not be run')
      }
      setNotice(
        payload.run.replayed
          ? `Existing replay ${payload.run.globalId} was reloaded.`
          : `Replay ${payload.run.globalId} completed and its evidence was persisted.`,
      )
      await load(payload.run.globalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Historical replay could not be run')
    } finally {
      setRunning(false)
    }
  }

  if (loading && !walkthrough) {
    return (
      <Box sx={{ minHeight: 300, display: 'grid', placeItems: 'center' }}>
        <CircularProgress size={30} />
      </Box>
    )
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1220, mx: 'auto' }}>
      <Stack spacing={2}>
        <Alert severity="info" icon={<ReplayRounded />}>
          <Typography fontWeight={700}>Development-only, non-postage replay</Typography>
          <Typography variant="body2">
            This command replays normalized historical inputs against recorded carrier responses.
            It does not call Shopify, Faire, UPS, or FedEx, purchase postage, create a label, or
            change a customer order.
          </Typography>
        </Alert>

        {error && (
          <Alert severity="error" onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert severity="success" onClose={() => setNotice('')}>
            {notice}
          </Alert>
        )}

        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            alignItems={{ xs: 'stretch', md: 'flex-end' }}
            spacing={1.25}
          >
            <TextField
              select
              fullWidth
              size="small"
              label="Historical replay scenario"
              value={scenarioId}
              disabled={running || !walkthrough?.scenarios.length}
              onChange={(event) => {
                const nextScenarioId = event.target.value
                setScenarioId(nextScenarioId)
                setSelectedRunGlobalId(
                  walkthrough?.runs.find((run) => run.scenarioId === nextScenarioId)
                    ?.globalId || null,
                )
              }}
              sx={{ flex: '1 1 420px' }}
            >
              {walkthrough?.scenarios.map((scenario) => (
                <MenuItem key={scenario.id} value={scenario.id}>
                  {scenario.title} · {providerLabel(scenario.provider)}
                </MenuItem>
              ))}
            </TextField>
            <Button
              variant="contained"
              disabled={!scenarioId || running}
              startIcon={running ? <CircularProgress size={16} /> : <PlayArrowRounded />}
              onClick={() => void runReplay()}
              sx={{ minHeight: 40, whiteSpace: 'nowrap' }}
            >
              {running ? 'Running replay' : 'Run replay'}
            </Button>
            <Button
              variant="outlined"
              disabled={loading || running}
              startIcon={loading ? <CircularProgress size={16} /> : <RefreshRounded />}
              onClick={() => void load(selectedRunGlobalId)}
              sx={{ minHeight: 40, whiteSpace: 'nowrap' }}
            >
              Reload results
            </Button>
          </Stack>

          {selectedScenario && (
            <Box sx={{ mt: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip
                  size="small"
                  label={providerLabel(selectedScenario.provider)}
                  color={selectedScenario.provider === 'shopify' ? 'success' : 'info'}
                  variant="outlined"
                />
                <Chip
                  size="small"
                  label={selectedScenario.checkoutSource === 'live_callback_recorded'
                    ? 'Recorded Shopify live callback'
                    : 'Captured Faire checkout estimate'}
                  variant="outlined"
                />
                <Typography variant="caption" color="text.secondary">
                  {selectedScenario.sourceReference}
                  {' · '}
                  {selectedScenario.lines.length} lines
                  {' · '}
                  {selectedScenario.lines.reduce(
                    (total, line) => total + line.fulfillmentQuantity,
                    0,
                  )} fulfillment units
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                {selectedScenario.description}
              </Typography>
              {selectedScenario.provider === 'faire' && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  Faire does not call ClawPilot during checkout. This scenario starts with the
                  checkout estimate captured from Faire and runs ClawPilot only after order intake.
                </Alert>
              )}
            </Box>
          )}
        </Paper>

        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography fontWeight={700}>Persisted replay results</Typography>
            <Typography variant="body2" color="text.secondary">
              Select a recorded execution to reload its exact lifecycle evidence.
            </Typography>
          </Box>
          <Divider />
          {walkthrough?.runs.length ? (
            <TableContainer>
              <Table size="small" aria-label="Persisted pack and rate replay results">
                <TableHead>
                  <TableRow>
                    <TableCell>Run</TableCell>
                    <TableCell>Scenario</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Recorded</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {walkthrough.runs.map((run) => {
                    const scenario = walkthrough.scenarios.find(
                      (item) => item.id === run.scenarioId,
                    )
                    return (
                      <TableRow
                        key={run.globalId}
                        hover
                        selected={run.globalId === selectedRunGlobalId}
                        onClick={() => {
                          setScenarioId(run.scenarioId)
                          setSelectedRunGlobalId(run.globalId)
                        }}
                        sx={{ cursor: 'pointer' }}
                      >
                        <TableCell>
                          <Typography variant="body2" fontWeight={600} sx={referenceSx}>
                            {run.globalId}
                          </Typography>
                          {run.replayed && (
                            <Typography variant="caption" color="text.secondary">
                              Idempotent reload
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>{scenario?.title || run.scenarioTitle}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            variant="outlined"
                            color={stageColor(run.status)}
                            label={displayCode(run.status)}
                          />
                        </TableCell>
                        <TableCell>
                          {formatUserDateTime(run.createdAt, dateTime, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                            fallback: '—',
                          })}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography fontWeight={600}>No persisted replay runs</Typography>
              <Typography variant="body2" color="text.secondary">
                Choose a historical scenario and run it to create the first evidence record.
              </Typography>
            </Box>
          )}
        </Paper>

        {selectedRun && (
          <Stack spacing={1.5}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              gap={1}
            >
              <Box>
                <Typography variant="h6" fontWeight={700}>Two-pass lifecycle evidence</Typography>
                <Typography variant="caption" color="text.secondary" sx={referenceSx}>
                  {selectedRun.globalId}
                </Typography>
              </Box>
              <Chip
                label={displayCode(selectedRun.status)}
                color={stageColor(selectedRun.status)}
                variant="outlined"
              />
            </Stack>

            {selectedRun.stages.checkoutQuote.kind === 'marketplace_estimate' ? (
              <StageShell
                sequence={1}
                title="Marketplace checkout estimate"
                icon={<ShoppingCartCheckoutRounded fontSize="small" />}
                status={selectedRun.stages.checkoutQuote.status}
                summary="The replay preserves Faire’s captured marketplace estimate. Faire did not call ClawPilot at checkout."
                gates={[{
                  code: 'faire_checkout_boundary',
                  label: 'No ClawPilot checkout callback',
                  status: 'passed',
                  detail: 'No ClawPilot packages, UPS rates, or FedEx rates are attributed to Faire checkout.',
                }]}
                evidenceReferences={[
                  selectedRun.stages.checkoutQuote.runGlobalId,
                  selectedRun.stages.checkoutQuote.inputHash,
                  selectedRun.stages.checkoutQuote.resultHash,
                ]}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Captured checkout shipping charge
                    </Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {formatMoney(
                        selectedRun.stages.checkoutQuote.capturedCheckoutShippingChargeMinor,
                        selectedRun.stages.checkoutQuote.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      ClawPilot checkout packages and rates
                    </Typography>
                    <Typography variant="body2">Not run</Typography>
                  </Box>
                </Stack>
                <Alert severity="info" sx={{ mt: 1.5 }}>
                  {selectedRun.stages.checkoutQuote.detail}
                </Alert>
              </StageShell>
            ) : (
              <StageShell
                sequence={1}
                title="Checkout quote pass"
                icon={<ShoppingCartCheckoutRounded fontSize="small" />}
                status={selectedRun.stages.checkoutQuote.status}
                summary="The replay applies the recorded Shopify live-callback input to the checkout carton and rate pass."
                gates={[
                  {
                    code: 'checkout_source',
                    label: 'Checkout source is explicit',
                    status: 'passed',
                    detail: 'Recorded Shopify callback; no live provider call during replay.',
                  },
                  {
                    code: 'two_carrier_comparison',
                    label: 'UPS and FedEx were compared',
                    status: new Set(
                      selectedRun.stages.checkoutQuote.rateChoices.map(
                        (rate) => rate.provider,
                      ),
                    ).size === 2 ? 'passed' : 'warning',
                    detail: 'Every displayed choice uses the same checkout package count.',
                  },
                ]}
                evidenceReferences={[
                  selectedRun.stages.checkoutQuote.runGlobalId,
                  selectedRun.stages.checkoutQuote.inputHash,
                  selectedRun.stages.checkoutQuote.resultHash,
                ]}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} flexWrap="wrap" gap={2}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Customer checkout shipping charge
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.checkoutQuote.checkoutShippingChargeMinor,
                        selectedRun.stages.checkoutQuote.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Checkout carrier estimate
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.checkoutQuote.selectedCarrierCostMinor,
                        selectedRun.stages.checkoutQuote.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Checkout charge-to-estimate variance
                    </Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {formatMoney(
                        selectedRun.stages.checkoutQuote.estimatedShippingVarianceMinor,
                        selectedRun.stages.checkoutQuote.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Physical packages</Typography>
                    <Typography variant="body2">
                      {selectedRun.stages.checkoutQuote.packageCount}
                    </Typography>
                  </Box>
                </Stack>
                <Alert severity="info" sx={{ mt: 1.5 }}>
                  No carrier invoice has been imported for this replay. Billed
                  actual and MUD are not calculated at checkout.
                </Alert>
                <Divider sx={{ my: 1.5 }} />
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                  Recorded checkout choices
                </Typography>
                <RateChoices stage={selectedRun.stages.checkoutQuote} />
                <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.75 }}>
                  Checkout package allocation
                </Typography>
                <PackageCards packages={selectedRun.stages.checkoutQuote.packages} />
              </StageShell>
            )}

            <StageShell
              sequence={2}
              title="Order intake boundary"
              icon={<Inventory2Rounded fontSize="small" />}
              status={selectedRun.stages.orderIntake.status}
              summary={selectedRun.stages.orderIntake.detail}
              gates={[{
                code: 'customer_neutral_intake',
                label: 'Intake precedes CRM mutation',
                status: selectedRun.stages.orderIntake.customerNeutral
                  ? 'passed'
                  : 'failed',
                detail: 'The retained intake evidence has no CRM customer attached.',
              }]}
              evidenceReferences={[
                selectedRun.stages.orderIntake.sourceReference,
                selectedRun.stages.orderIntake.intakeEvidenceHash,
              ]}
            >
              <Typography variant="body2">
                {providerLabel(selectedRun.stages.orderIntake.provider)}
                {' · '}
                {selectedRun.stages.orderIntake.sourceReference}
              </Typography>
            </StageShell>

            <StageShell
              sequence={3}
              title="CRM customer linkage"
              icon={<PersonSearchRounded fontSize="small" />}
              status={selectedRun.stages.customerResolution.status}
              summary={selectedRun.stages.customerResolution.detail}
              gates={[
                {
                  code: 'crm_identity',
                  label: 'Provider identity resolves to one CRM customer',
                  status: selectedRun.stages.customerResolution.outcome === 'ambiguous'
                    ? 'warning'
                    : 'passed',
                  detail: selectedRun.stages.customerResolution.outcome === 'ambiguous'
                    ? 'Multiple candidates intentionally stop the replay before fulfillment.'
                    : 'The replay created or reused one durable CRM organization identity.',
                },
              ]}
              evidenceReferences={[selectedRun.stages.customerResolution.identityKey]}
            >
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                <Box>
                  <Typography variant="caption" color="text.secondary">Resolution</Typography>
                  <Typography variant="body2" fontWeight={600}>
                    {displayCode(selectedRun.stages.customerResolution.outcome)}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">CRM organization</Typography>
                  <Typography variant="body2">
                    {selectedRun.stages.customerResolution.customerGlobalId || 'Review required'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">Identity candidates</Typography>
                  <Typography variant="body2">
                    {selectedRun.stages.customerResolution.candidateCount}
                  </Typography>
                </Box>
              </Stack>
            </StageShell>

            {selectedRun.stages.fulfillmentExecution ? (
              <StageShell
                sequence={4}
                title="Fulfillment rerun"
                icon={<Inventory2Rounded fontSize="small" />}
                status={selectedRun.stages.fulfillmentExecution.status}
                summary="Current inventory, product dimensions, packaging materials, and ship-from facts are rerun before shipment."
                gates={[
                  singleServiceGate(selectedRun),
                  {
                    code: 'two_carrier_comparison',
                    label: 'UPS and FedEx were compared',
                    status: new Set(
                      selectedRun.stages.fulfillmentExecution.rateChoices.map(
                        (rate) => rate.provider,
                      ),
                    ).size === 2 ? 'passed' : 'warning',
                    detail: 'Every displayed choice uses the same fulfillment package count.',
                  },
                ]}
                evidenceReferences={[
                  selectedRun.stages.fulfillmentExecution.runGlobalId,
                  selectedRun.stages.fulfillmentExecution.inputHash,
                  selectedRun.stages.fulfillmentExecution.resultHash,
                ]}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} flexWrap="wrap" gap={2}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Customer checkout shipping charge
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.fulfillmentExecution.checkoutShippingChargeMinor,
                        selectedRun.stages.fulfillmentExecution.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Pre-label carrier estimate
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.fulfillmentExecution.selectedCarrierCostMinor,
                        selectedRun.stages.fulfillmentExecution.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Checkout charge-to-pre-label variance
                    </Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {formatMoney(
                        selectedRun.stages.fulfillmentExecution.estimatedShippingVarianceMinor,
                        selectedRun.stages.fulfillmentExecution.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Physical packages</Typography>
                    <Typography variant="body2">
                      {selectedRun.stages.fulfillmentExecution.packageCount}
                    </Typography>
                  </Box>
                </Stack>
                <Divider sx={{ my: 1.5 }} />
                <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
                  Recorded fulfillment choices
                </Typography>
                <RateChoices stage={selectedRun.stages.fulfillmentExecution} />
                <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.75 }}>
                  Final package allocation
                </Typography>
                <PackageCards packages={selectedRun.stages.fulfillmentExecution.packages} />
              </StageShell>
            ) : (
              <StageShell
                sequence={4}
                title="Fulfillment rerun"
                icon={<Inventory2Rounded fontSize="small" />}
                status="warning"
                summary="Fulfillment did not run because the CRM customer gate requires operator review."
                gates={[{
                  code: 'crm_customer_blocked',
                  label: 'Resolve CRM customer first',
                  status: 'warning',
                  detail: 'No package, rate, label, or document facts were invented after the blocker.',
                }]}
              >
                <Alert severity="warning">Expected blocker; no fulfillment evidence exists.</Alert>
              </StageShell>
            )}

            {selectedRun.stages.variance ? (
              <StageShell
                sequence={5}
                title="Checkout-to-fulfillment variance"
                icon={<LocalShippingRounded fontSize="small" />}
                status={selectedRun.stages.variance.status}
                summary="The checkout shipping charge remains immutable while the pre-label carrier estimate and signed variances are recorded separately."
                gates={[{
                  code: 'variance_preserved',
                  label: 'Both passes remain independently auditable',
                  status: 'passed',
                  detail: 'The fulfillment rerun does not overwrite checkout packages, rates, or charge.',
                }]}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} flexWrap="wrap" gap={2}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Customer checkout shipping charge
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.variance.checkoutShippingChargeMinor,
                        selectedRun.stages.variance.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Checkout carrier estimate
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.variance.checkoutCarrierCostMinor,
                        selectedRun.stages.variance.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Pre-label carrier estimate
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.variance.fulfillmentCarrierCostMinor,
                        selectedRun.stages.variance.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Pre-label rate variance
                    </Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {formatMoney(
                        selectedRun.stages.variance.preLabelRateVarianceMinor,
                        selectedRun.stages.variance.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Checkout charge-to-pre-label variance
                    </Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {formatMoney(
                        selectedRun.stages.variance.estimatedShippingVarianceMinor,
                        selectedRun.stages.variance.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Package-count delta</Typography>
                    <Typography variant="body2">
                      {selectedRun.stages.variance.packageCountDelta}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">Service changed</Typography>
                    <Typography variant="body2">
                      {selectedRun.stages.variance.serviceChanged ? 'Yes' : 'No'}
                    </Typography>
                  </Box>
                </Stack>
                <Alert severity="info" sx={{ mt: 1.5 }}>
                  Carrier billed actual is pending an imported and matched
                  billing CSV. MUD is evaluated only in that billing workflow
                  when an effective directive is configured.
                </Alert>
                {selectedRun.stages.variance.causes.length > 0 && (
                  <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mt: 1.25 }}>
                    {selectedRun.stages.variance.causes.map((reason) => (
                      <Chip key={reason} size="small" label={displayCode(reason)} variant="outlined" />
                    ))}
                  </Stack>
                )}
              </StageShell>
            ) : (
              selectedRun.stages.fulfillmentExecution
              && selectedRun.stages.checkoutQuote.kind === 'marketplace_estimate'
            ) ? (
              <StageShell
                sequence={5}
                title="Marketplace estimate vs post-intake fulfillment"
                icon={<LocalShippingRounded fontSize="small" />}
                status="warning"
                summary="Faire never called ClawPilot at checkout, so there is no checkout carrier-estimate or package-plan baseline to compare."
                gates={[{
                  code: 'faire_variance_boundary',
                  label: 'No fabricated checkout variance',
                  status: 'passed',
                  detail: 'The captured checkout shipping charge and post-intake carrier estimate remain separate facts.',
                }]}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Captured Faire checkout shipping charge
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.checkoutQuote.capturedCheckoutShippingChargeMinor,
                        selectedRun.stages.checkoutQuote.currency,
                      )}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Pre-label carrier estimate
                    </Typography>
                    <Typography variant="body2">
                      {formatMoney(
                        selectedRun.stages.fulfillmentExecution.selectedCarrierCostMinor,
                        selectedRun.stages.fulfillmentExecution.currency,
                      )}
                    </Typography>
                  </Box>
                </Stack>
                <Alert severity="info" sx={{ mt: 1.5 }}>
                  Carrier billed actual is pending an imported and matched
                  billing CSV. No MUD is calculated in this replay.
                </Alert>
              </StageShell>
            ) : (
              <StageShell
                sequence={5}
                title="Checkout-to-fulfillment variance"
                icon={<LocalShippingRounded fontSize="small" />}
                status="warning"
                summary="Variance is unavailable because the fail-closed CRM gate stopped fulfillment."
              >
                <Alert severity="warning">No second pass exists to compare.</Alert>
              </StageShell>
            )}

            <StageShell
              sequence={6}
              title="Recorded label finalization"
              icon={<LocalShippingRounded fontSize="small" />}
              status={selectedRun.stages.labelFinalization.status}
              summary={selectedRun.stages.labelFinalization.detail}
              gates={[
                {
                  code: 'recorded_response_only',
                  label: 'No provider write or postage purchase',
                  status: 'passed',
                  detail: 'Label and tracking facts are replayed from recorded evidence only.',
                },
                {
                  code: 'tracking_per_package',
                  label: 'Every finalized package has tracking',
                  status: selectedRun.stages.labelFinalization.packages.every(
                    (item) => item.status !== 'finalized' || Boolean(item.trackingNumber),
                  ) ? 'passed' : 'failed',
                  detail: 'A finalized package cannot advance without its own tracking number.',
                },
              ]}
            >
              <Stack spacing={1}>
                {selectedRun.stages.labelFinalization.packages.map((item) => (
                  <Paper key={item.packageKey} variant="outlined" sx={{ p: 1.25 }}>
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      justifyContent="space-between"
                      gap={1}
                    >
                      <Box>
                        <Typography fontWeight={700}>Package {item.sequence}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {item.carrier && item.serviceCode
                            ? `${item.carrier} · ${item.serviceCode}`
                            : 'No recorded label finalization'}
                        </Typography>
                      </Box>
                      <Box sx={{ textAlign: { xs: 'left', sm: 'right' } }}>
                        <Chip
                          size="small"
                          color={item.status === 'finalized' ? 'success' : 'warning'}
                          label={displayCode(item.status)}
                        />
                        <Typography variant="body2" sx={{ mt: 0.5 }}>
                          {item.trackingNumber || 'Tracking not assigned'}
                        </Typography>
                        {item.recordedLabelReference && (
                          <Typography variant="caption" color="text.secondary" sx={referenceSx}>
                            {item.recordedLabelReference}
                          </Typography>
                        )}
                      </Box>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </StageShell>

            <StageShell
              sequence={7}
              title="Tracking-gated package documents"
              icon={<PrintRounded fontSize="small" />}
              status={selectedRun.stages.packageDocuments.status}
              summary={selectedRun.stages.packageDocuments.detail}
              gates={[{
                code: 'tracking_gated_final_slip',
                label: 'Final slip requires package tracking',
                status: selectedRun.stages.packageDocuments.packages.every(
                  (item) => (
                    item.finalPackingSlipStatus !== 'ready'
                    || Boolean(item.trackingNumber && item.finalPackingSlipGlobalId)
                  ),
                ) ? 'passed' : 'failed',
                detail: 'Pre-label documents remain pack work instructions; they are not final packing slips.',
              }]}
            >
              <Stack spacing={1}>
                {selectedRun.stages.packageDocuments.packages.map((item) => {
                  const finalReady = (
                    item.finalPackingSlipStatus === 'ready'
                    && Boolean(item.trackingNumber)
                    && Boolean(item.finalPackingSlipGlobalId)
                  )
                  return (
                    <Paper key={item.packageKey} variant="outlined" sx={{ p: 1.25 }}>
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        justifyContent="space-between"
                        alignItems={{ xs: 'flex-start', sm: 'center' }}
                        gap={1}
                      >
                        <Box>
                          <Typography fontWeight={700}>Package {item.sequence}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            Tracking: {item.trackingNumber || 'Not assigned'}
                          </Typography>
                          {item.finalPackingSlipGlobalId && (
                            <Typography variant="caption" color="text.secondary" sx={referenceSx}>
                              {item.finalPackingSlipGlobalId}
                            </Typography>
                          )}
                        </Box>
                        <Stack direction="row" flexWrap="wrap" gap={0.75}>
                          <Chip
                            size="small"
                            variant="outlined"
                            label="Pre-label: pack work instruction"
                          />
                          <Chip
                            size="small"
                            color={finalReady ? 'success' : 'warning'}
                            icon={finalReady
                              ? <CheckCircleRounded />
                              : <LockRounded />}
                            label={finalReady
                              ? 'Final packing slip ready'
                              : displayCode(item.finalPackingSlipStatus)}
                          />
                          {finalReady && item.finalPackingSlipGlobalId && (
                            <Button
                              component="a"
                              size="small"
                              variant="outlined"
                              href={`/api/operations/artifacts/${encodeURIComponent(
                                item.finalPackingSlipGlobalId,
                              )}`}
                              download
                            >
                              Download PDF
                            </Button>
                          )}
                        </Stack>
                      </Stack>
                    </Paper>
                  )
                })}
              </Stack>
              <Alert severity="info" sx={{ mt: 1.25 }}>
                A provisional pack worksheet may print before rating. A final package packing slip
                remains locked until that exact package has a label and tracking number.
              </Alert>
            </StageShell>
          </Stack>
        )}
      </Stack>
    </Box>
  )
}
