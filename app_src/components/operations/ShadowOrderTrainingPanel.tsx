'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import ScienceRounded from '@mui/icons-material/ScienceRounded'
import TaskAltRounded from '@mui/icons-material/TaskAltRounded'
import UndoRounded from '@mui/icons-material/UndoRounded'
import WarehouseRounded from '@mui/icons-material/WarehouseRounded'
import { SHADOW_TRAINING_CONFIRMATION } from '@/lib/operations/shadowTraining'

type TrainingAction =
  | 'plan'
  | 'release'
  | 'confirm-picks'
  | 'verify-pack'
  | 'complete'
  | 'undo'
  | 'reset'

type TrainingRun = {
  globalId: string
  sourceOrderGlobalId: string
  generation: number
  provider: 'shopify' | 'faire'
  accountEnvironment: 'sandbox' | 'production'
  state: 'enabled' | 'planned' | 'released' | 'picked' | 'packed' | 'labeled' | 'completed' | 'reset' | 'reset_blocked'
  rowVersion: number
  sourceChanged: boolean
  candidateChanged: boolean
  trainingEvidenceSealed: boolean
  restartRequiredBeforePlan: boolean
  activationChanged: boolean
  sourceStatus: string
  cartonizationEvidenceGlobalId: string | null
  availableActions: TrainingAction[]
  counters: {
    commerceProviderWrites: 0
    productionPostage: 0
    inventoryMutations: 0
    packagingStockMutations: 0
  }
  packages: Array<{ globalId: string; status: string }>
  pickTasks: Array<{ globalId: string; status: string }>
  labelAndPrint: { available: false; code: string; message: string }
  resetBlockerCode: string | null
}

type TrainingPayload = {
  ok?: boolean
  error?: string
  code?: string
  training?: {
    eligible: boolean
    eligibilityCode: string | null
    run: TrainingRun | null
  }
  run?: TrainingRun
}

export type ShadowTrainingPlanTarget = {
  runGlobalId: string
  expectedRowVersion: number
  cartonizationEvidenceGlobalId: string | null
}

const progression: Partial<Record<TrainingRun['state'], {
  action: Exclude<TrainingAction, 'plan' | 'reset'>
  label: string
  icon: typeof WarehouseRounded
  reason: string
}>> = {
  planned: {
    action: 'release',
    label: 'Release training wave',
    icon: WarehouseRounded,
    reason: 'Release the local-only training plan',
  },
  released: {
    action: 'confirm-picks',
    label: 'Confirm training picks',
    icon: TaskAltRounded,
    reason: 'Confirm all local-only training pick tasks',
  },
  picked: {
    action: 'verify-pack',
    label: 'Verify training pack',
    icon: Inventory2Rounded,
    reason: 'Verify the local-only training packages',
  },
  packed: {
    action: 'complete',
    label: 'Simulate completion',
    icon: CheckCircleRounded,
    reason: 'Complete the local simulation without a store write or postage',
  },
}

function resultError(payload: TrainingPayload, fallback: string) {
  return `${payload.error || fallback}${payload.code ? ` [${payload.code}]` : ''}`
}

export default function ShadowOrderTrainingPanel({
  orderGlobalId,
  canExecute,
  disabled,
  refreshToken,
  onPlan,
}: {
  orderGlobalId: string
  canExecute: boolean
  disabled: boolean
  refreshToken: number
  onPlan: (target: ShadowTrainingPlanTarget) => void
}) {
  const [training, setTraining] = useState<TrainingPayload['training'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<TrainingAction | 'enable' | ''>('')
  const [error, setError] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ order: orderGlobalId })
      const response = await fetch(`/api/operations/training?${params}`, {
        cache: 'no-store',
        signal,
      })
      const payload = await response.json().catch(() => ({})) as TrainingPayload
      if (!response.ok || !payload.ok || !payload.training) {
        throw new Error(resultError(payload, 'Training eligibility is unavailable'))
      }
      setTraining(payload.training)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(caught instanceof Error ? caught.message : 'Training eligibility is unavailable')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [orderGlobalId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, refreshToken])

  const command = async (
    action: Exclude<TrainingAction, 'plan'> | 'enable',
    reason: string,
  ) => {
    const run = training?.run || null
    if (action !== 'enable' && !run) return
    if (
      action === 'reset'
      && !window.confirm(
        'Reset this exact training run? The run becomes terminal, its audit evidence is retained, and a new run can be enabled afterward.',
      )
    ) return
    if (
      action === 'undo'
      && !window.confirm(
        'Undo only the last local training step? This does not change the connected store, operational inventory, packaging stock, canonical warehouse work, or postage.',
      )
    ) return
    setPending(action)
    setError('')
    try {
      const body = action === 'enable'
        ? {
          action,
          orderGlobalId,
          confirmation: SHADOW_TRAINING_CONFIRMATION,
          reason: 'Enable this exact order for local-only order training',
        }
        : {
          action,
          runGlobalId: run!.globalId,
          expectedRowVersion: run!.rowVersion,
          reason,
        }
      const response = await fetch('/api/operations/training', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `shadow-training:${action}:${orderGlobalId}:${crypto.randomUUID()}`,
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({})) as TrainingPayload
      if (!response.ok || !payload.ok || !payload.run) {
        throw new Error(resultError(payload, `Training ${action} failed`))
      }
      if (action === 'reset') {
        await load()
      } else {
        setTraining({ eligible: false, eligibilityCode: 'TRAINING_ALREADY_ENABLED', run: payload.run })
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Training ${action} failed`)
    } finally {
      setPending('')
    }
  }

  if (loading) {
    return <Box sx={{ py: 1, textAlign: 'center' }}><CircularProgress size={22} /></Box>
  }
  if (error && !training) return <Alert severity="error">{error}</Alert>

  const run = training?.run || null
  if (!run) {
    if (!training?.eligible) {
      return (
        <Typography variant="body2" color="text.secondary">
          This order is not eligible for a new training run ({training?.eligibilityCode || 'not eligible'}).
        </Typography>
      )
    }
    return (
      <Stack spacing={1}>
        <Button
          fullWidth
          variant="contained"
          startIcon={pending === 'enable' ? <CircularProgress size={16} /> : <ScienceRounded />}
          disabled={!canExecute || disabled || Boolean(pending)}
          onClick={() => void command(
            'enable',
            'Enable this exact order for local-only order training',
          )}
        >
          Enable training
        </Button>
        <Typography variant="caption" color="text.secondary">
          Creates a local simulation for this order only. The connected store remains the source of truth and receives no training writes.
        </Typography>
      </Stack>
    )
  }

  const next = progression[run.state]
  const NextIcon = next?.icon || WarehouseRounded
  const actionBusy = Boolean(pending)
  return (
    <Stack spacing={1.25}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Chip size="small" color="info" label="Training enabled" />
        <Chip size="small" variant="outlined" label={`Run ${run.generation} · ${run.state}`} />
        <Chip size="small" variant="outlined" label={`${run.accountEnvironment} store`} />
      </Stack>
      <Alert severity="info">
        Local training overlay: 0 store writes, 0 production postage, 0 operational inventory changes, and 0 packaging-stock changes.
      </Alert>
      {run.activationChanged && (
        <Alert severity="info">
          The advanced safety profile changed after this run was enabled. This exact local training run remains available because it cannot write to the connected store, production postage, operational inventory, or packaging stock.
        </Alert>
      )}
      {run.restartRequiredBeforePlan && (
        <Alert severity="warning">
          The store line or product facts changed before a local training plan was sealed. Reset this run and enable a new run from the latest imported order; Prepare training order is unavailable.
        </Alert>
      )}
      {run.sourceChanged && !run.restartRequiredBeforePlan && (
        <Alert severity="warning">
          The store order has changed to {run.sourceStatus}. Provider state is still mirrored; the exact authorized training snapshot remains available and is not rewritten.
        </Alert>
      )}
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      <Typography variant="body2" color="text.secondary">
        {run.pickTasks.length} training pick {run.pickTasks.length === 1 ? 'task' : 'tasks'} · {run.packages.length} training {run.packages.length === 1 ? 'package' : 'packages'}
      </Typography>
      {run.state === 'enabled'
        && !run.restartRequiredBeforePlan
        && run.availableActions.includes('plan') && (
        <Button
          fullWidth
          variant="contained"
          startIcon={<ScienceRounded />}
          disabled={!canExecute || disabled || actionBusy}
          onClick={() => onPlan({
            runGlobalId: run.globalId,
            expectedRowVersion: run.rowVersion,
            cartonizationEvidenceGlobalId: run.cartonizationEvidenceGlobalId,
          })}
        >
          Prepare training order
        </Button>
      )}
      {next && run.availableActions.includes(next.action) && (
        <Button
          fullWidth
          variant="contained"
          startIcon={pending === next.action
            ? <CircularProgress size={16} />
            : <NextIcon />}
          disabled={!canExecute || disabled || actionBusy}
          onClick={() => void command(next.action, next.reason)}
        >
          {next.label}
        </Button>
      )}
      {(run.state === 'packed' || run.state === 'completed') && (
        <Alert severity="info">
          {run.labelAndPrint.message}
        </Alert>
      )}
      {run.availableActions.includes('undo') && (
        <Button
          fullWidth
          color="info"
          variant="outlined"
          startIcon={pending === 'undo' ? <CircularProgress size={16} /> : <UndoRounded />}
          disabled={!canExecute || disabled || actionBusy}
          onClick={() => void command(
            'undo',
            'Undo only the last local training step and preserve its audit history',
          )}
        >
          Undo last training step
        </Button>
      )}
      {run.availableActions.includes('reset') && (
        <Button
          fullWidth
          color="warning"
          variant="outlined"
          startIcon={pending === 'reset' ? <CircularProgress size={16} /> : <ReplayRounded />}
          disabled={!canExecute || disabled || actionBusy}
          onClick={() => void command(
            'reset',
            'Reset this exact local training run and retain its audit history',
          )}
        >
          Reset training run
        </Button>
      )}
    </Stack>
  )
}
