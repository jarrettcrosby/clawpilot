'use client'

import { useState } from 'react'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import ScienceRounded from '@mui/icons-material/ScienceRounded'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import {
  packageCatalogEntries,
  packageCatalogEntry,
  type PackageCatalogEntryId,
} from '@/lib/operations/packageCatalog'

type ClassificationInput = {
  handlingUnitKey: string
  description: string
  dimensionsMm: {
    length: number
    width: number
    height: number
  }
  grossWeightGrams: number
  mixedCommodities: boolean
  fullDensityScaleConfirmed: boolean
  handlingConcern: boolean
  stowabilityConcern: boolean
  liabilityConcern: boolean
  classificationReference: string | null
  nmfcCode: string | null
}

type ClassificationAssessment = ClassificationInput & {
  contractVersion: string
  inputHash: string
  volumeCubicFeet: number
  densityPcf: number
  recommendedFreightClass: string
  evidenceEligible: boolean
  blockers: string[]
}

type ClassificationPayload = {
  ok?: boolean
  error?: string
  assessment?: ClassificationAssessment
  result?: {
    assessmentGlobalId: string
    replayed: boolean
  }
}

const BLOCKER_LABELS: Record<string, string> = {
  full_density_scale_not_confirmed:
    'Confirm that the commodity uses the full density scale.',
  mixed_commodities_require_item_classification:
    'Mixed commodities require item-level classification review.',
  handling_concern_requires_review:
    'Resolve the unusual handling characteristic.',
  stowability_concern_requires_review:
    'Resolve the unusual stowability characteristic.',
  liability_concern_requires_review:
    'Resolve the unusual liability characteristic.',
}

type Draft = {
  catalogEntryId: PackageCatalogEntryId
  handlingUnitKey: string
  description: string
  lengthMm: string
  widthMm: string
  heightMm: string
  grossWeightGrams: string
  mixedCommodities: boolean
  fullDensityScaleConfirmed: boolean
  handlingConcern: boolean
  stowabilityConcern: boolean
  liabilityConcern: boolean
  classificationReference: string
  nmfcCode: string
  attestation: string
}

const INITIAL_DRAFT: Draft = {
  catalogEntryId: 'pallet_48x40',
  // Internal assessment correlation only. It must not encode the prefill
  // catalog choice because that choice is deliberately not attested.
  handlingUnitKey: 'proposed-pallet-1',
  description: '48 × 40 in pallet',
  lengthMm: '1219',
  widthMm: '1016',
  heightMm: '',
  grossWeightGrams: '',
  mixedCommodities: false,
  fullDensityScaleConfirmed: false,
  handlingConcern: false,
  stowabilityConcern: false,
  liabilityConcern: false,
  classificationReference: '',
  nmfcCode: '',
  attestation: '',
}

// The assessment persists physical pallet facts, not a carrier booking. Keep
// its selectable set to common ClawPilot pallet footprints.
const LTL_HANDLING_UNIT_OPTIONS = packageCatalogEntries({
  usage: 'ltl_handling_unit',
  includeCanonical: true,
})

async function postClassification(
  body: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const response = await fetch('/api/operations/freight-classification', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({})) as ClassificationPayload
  if (!response.ok || !result.ok) {
    throw new Error(result.error || 'Freight classification request failed')
  }
  return result
}

export default function LtlFreightClassAssessmentPanel() {
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT)
  const [assessment, setAssessment] = useState<ClassificationAssessment | null>(null)
  const [assessmentGlobalId, setAssessmentGlobalId] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [pending, setPending] = useState<'calculate' | 'attest' | ''>('')
  const [error, setError] = useState('')

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setAssessment(null)
    setAssessmentGlobalId('')
    setIdempotencyKey('')
    setError('')
  }

  function chooseHandlingUnit(catalogEntryId: PackageCatalogEntryId) {
    const entry = packageCatalogEntry(catalogEntryId)
    if (!entry || !entry.usages.includes('ltl_handling_unit')) return
    setDraft((current) => ({
      ...current,
      catalogEntryId,
      description: entry.label,
      lengthMm: entry.defaultDimensionsMm.length === null
        ? ''
        : String(entry.defaultDimensionsMm.length),
      widthMm: entry.defaultDimensionsMm.width === null
        ? ''
        : String(entry.defaultDimensionsMm.width),
      heightMm: entry.defaultDimensionsMm.height === null
        ? ''
        : String(entry.defaultDimensionsMm.height),
    }))
    setAssessment(null)
    setAssessmentGlobalId('')
    setIdempotencyKey('')
    setError('')
  }

  function classificationInput(): ClassificationInput {
    // catalogEntryId is intentionally a UI prefill choice, not attested
    // evidence. Operators may edit every physical fact after choosing a
    // footprint; the immutable assessment seals those final facts instead.
    return {
      handlingUnitKey: draft.handlingUnitKey,
      description: draft.description,
      dimensionsMm: {
        length: Number(draft.lengthMm),
        width: Number(draft.widthMm),
        height: Number(draft.heightMm),
      },
      grossWeightGrams: Number(draft.grossWeightGrams),
      mixedCommodities: draft.mixedCommodities,
      fullDensityScaleConfirmed: draft.fullDensityScaleConfirmed,
      handlingConcern: draft.handlingConcern,
      stowabilityConcern: draft.stowabilityConcern,
      liabilityConcern: draft.liabilityConcern,
      classificationReference:
        draft.classificationReference.trim() || null,
      nmfcCode: draft.nmfcCode.trim() || null,
    }
  }

  async function calculate() {
    setPending('calculate')
    setError('')
    setAssessmentGlobalId('')
    try {
      const result = await postClassification({
        action: 'calculate-density',
        assessment: classificationInput(),
      })
      if (!result.assessment) throw new Error('Classification result was incomplete')
      setAssessment(result.assessment)
      setIdempotencyKey(`operations-ltl-density:${crypto.randomUUID()}`)
    } catch (caught) {
      setAssessment(null)
      setError(caught instanceof Error ? caught.message : 'Unable to calculate freight class')
    } finally {
      setPending('')
    }
  }

  async function attest() {
    if (!assessment?.evidenceEligible || !idempotencyKey) return
    setPending('attest')
    setError('')
    try {
      const result = await postClassification({
        action: 'attest-density',
        assessment: classificationInput(),
        attestation: draft.attestation,
      }, idempotencyKey)
      if (!result.result?.assessmentGlobalId) {
        throw new Error('Saved classification evidence was incomplete')
      }
      setAssessmentGlobalId(result.result.assessmentGlobalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save freight class evidence')
    } finally {
      setPending('')
    }
  }

  return (
    <Accordion
      disableGutters
      sx={{
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '8px !important',
        backgroundImage: 'none',
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreRounded />}>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <ScienceRounded color="info" />
          <Typography fontWeight={700}>LTL freight-class assessment</Typography>
          <Chip size="small" label="Advisory until attested" variant="outlined" />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Box sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1fr 1.6fr' },
            gap: 2,
          }}>
            <TextField
              data-testid="ltl-handling-unit-select"
              select
              required
              label="Pallet footprint preset (prefill only)"
              value={draft.catalogEntryId}
              onChange={(event) => chooseHandlingUnit(
                event.target.value as PackageCatalogEntryId,
              )}
            >
              {LTL_HANDLING_UNIT_OPTIONS.map((entry) => (
                <MenuItem key={entry.id} value={entry.id}>
                  {entry.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              required
              label="Commodity / pallet description"
              value={draft.description}
              onChange={(event) => update('description', event.target.value)}
              inputProps={{ maxLength: 160 }}
            />
          </Box>

          <Box sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' },
            gap: 2,
          }}>
            <TextField
              required
              label="Pallet length (mm)"
              type="number"
              value={draft.lengthMm}
              onChange={(event) => update('lengthMm', event.target.value)}
              inputProps={{ min: 1, max: 10000, step: 1 }}
            />
            <TextField
              required
              label="Pallet width (mm)"
              type="number"
              value={draft.widthMm}
              onChange={(event) => update('widthMm', event.target.value)}
              inputProps={{ min: 1, max: 10000, step: 1 }}
            />
            <TextField
              required
              label="Pallet height (mm)"
              type="number"
              value={draft.heightMm}
              onChange={(event) => update('heightMm', event.target.value)}
              inputProps={{ min: 1, max: 10000, step: 1 }}
            />
            <TextField
              required
              label="Gross weight (g)"
              type="number"
              value={draft.grossWeightGrams}
              onChange={(event) => update('grossWeightGrams', event.target.value)}
              inputProps={{ min: 1, max: 100000000, step: 1 }}
            />
          </Box>

          <Stack spacing={0.25}>
            <FormControlLabel
              control={(
                <Checkbox
                  checked={draft.mixedCommodities}
                  onChange={(event) => update('mixedCommodities', event.target.checked)}
                />
              )}
              label="This pallet contains more than one commodity classification"
            />
            <FormControlLabel
              control={(
                <Checkbox
                  checked={draft.handlingConcern}
                  onChange={(event) => update('handlingConcern', event.target.checked)}
                />
              )}
              label="The freight has an unusual handling characteristic"
            />
            <FormControlLabel
              control={(
                <Checkbox
                  checked={draft.stowabilityConcern}
                  onChange={(event) => update('stowabilityConcern', event.target.checked)}
                />
              )}
              label="The freight has an unusual stowability characteristic"
            />
            <FormControlLabel
              control={(
                <Checkbox
                  checked={draft.liabilityConcern}
                  onChange={(event) => update('liabilityConcern', event.target.checked)}
                />
              )}
              label="The freight has an unusual liability characteristic"
            />
            <FormControlLabel
              control={(
                <Checkbox
                  checked={draft.fullDensityScaleConfirmed}
                  onChange={(event) => update(
                    'fullDensityScaleConfirmed',
                    event.target.checked,
                  )}
                />
              )}
              label="I confirmed this commodity is governed by the full NMFTA density scale"
            />
          </Stack>

          <Box sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1.5fr 1fr' },
            gap: 2,
          }}>
            <TextField
              required={draft.fullDensityScaleConfirmed}
              label="Classification source / reference"
              value={draft.classificationReference}
              onChange={(event) => update('classificationReference', event.target.value)}
              inputProps={{ maxLength: 120 }}
              helperText="Record the rule, tariff, licensed source, or operator reference used to confirm eligibility."
            />
            <TextField
              label="Verified NMFC item-subitem (optional)"
              value={draft.nmfcCode}
              onChange={(event) => update('nmfcCode', event.target.value)}
              inputProps={{ maxLength: 9 }}
              helperText="Not calculated here; enter only when independently verified."
            />
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems="flex-start">
            <Button
              type="button"
              variant="outlined"
              startIcon={pending === 'calculate'
                ? <CircularProgress size={18} />
                : <ScienceRounded />}
              disabled={Boolean(pending)}
              onClick={() => { void calculate() }}
            >
              Calculate density class
            </Button>
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}

          {assessment && (
            <Alert severity={assessment.evidenceEligible ? 'success' : 'warning'}>
              <Stack spacing={1}>
                <Typography fontWeight={700}>
                  Candidate class {assessment.recommendedFreightClass} ·{' '}
                  {assessment.densityPcf.toFixed(6)} lb/ft³
                </Typography>
                <Typography variant="body2">
                  Exact pallet volume: {assessment.volumeCubicFeet.toFixed(6)} ft³
                </Typography>
                {assessment.blockers.map((blocker) => (
                  <Typography key={blocker} variant="body2">
                    • {BLOCKER_LABELS[blocker] || blocker}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}

          {assessment?.evidenceEligible && (
            <Stack spacing={1.5}>
              <TextField
                required
                label="Operator attestation"
                value={draft.attestation}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  attestation: event.target.value,
                }))}
                inputProps={{ minLength: 10, maxLength: 120 }}
                helperText="Confirm the exact pallet facts and classification review in 10-120 characters."
              />
              <Box>
                <Button
                  type="button"
                  variant="contained"
                  startIcon={pending === 'attest'
                    ? <CircularProgress size={18} />
                    : <SaveRounded />}
                  disabled={Boolean(pending) || draft.attestation.trim().length < 10}
                  onClick={() => { void attest() }}
                >
                  Save immutable class evidence
                </Button>
              </Box>
            </Stack>
          )}

          {assessmentGlobalId && (
            <Alert severity="success">
              Saved as <strong>{assessmentGlobalId}</strong>. A future LTL pallet
              plan must match these exact dimensions, gross weight, class, and
              evidence before it can use this assessment.
            </Alert>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}
