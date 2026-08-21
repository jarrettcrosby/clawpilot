'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'

import type {
  OneOffShippingPackCommandResult,
  OneOffShippingPrintRecoveryResult,
  OneOffCarrierGroupCommandResult,
  OneOffPackedRateRefresh,
  OneOffShipmentExecutionState,
} from '@/lib/operations/oneOffShipments'
import {
  ONE_OFF_LIVE_POSTAGE_CONFIRMATION,
  ONE_OFF_PACK_CONFIRMATION,
} from '@/lib/operations/oneOffShipmentConstants'
import {
  readShippingOneOffRetainedCommand,
  replaceShippingOneOffRetainedCommandIfExact,
  shippingOneOffResponseIsDefinitiveClientRejection,
  shippingOneOffRetainedCommandsMatch,
  type ShippingOneOffCommandAction,
  type ShippingOneOffRetainedCommand,
} from '@/lib/operations/shippingOneOffRecovery'

type ExecutionPayload = {
  ok?: boolean
  error?: string
  code?: string
  state?: OneOffShipmentExecutionState
  result?: OneOffShippingPackCommandResult
    | OneOffShippingPrintRecoveryResult
    | OneOffPackedRateRefresh
    | OneOffCarrierGroupCommandResult
}

export type ExecutionOrderFence = {
  orderGlobalId: string
  generation: number
}

export function executionOrderFenceIsCurrent(
  request: ExecutionOrderFence,
  current: ExecutionOrderFence,
) {
  return request.orderGlobalId === current.orderGlobalId
    && request.generation === current.generation
}

export function mountedExecutionOrderFenceIsCurrent(
  mounted: boolean,
  request: ExecutionOrderFence,
  current: ExecutionOrderFence,
) {
  return mounted && executionOrderFenceIsCurrent(request, current)
}

export function executionStateLoadIsCurrent(
  mounted: boolean,
  request: ExecutionOrderFence,
  current: ExecutionOrderFence,
  requestEpoch: number,
  currentEpoch: number,
) {
  return mountedExecutionOrderFenceIsCurrent(mounted, request, current)
    && requestEpoch === currentEpoch
}

type CommandAction = ShippingOneOffCommandAction
type RetainedCommand = ShippingOneOffRetainedCommand
type ExecutionLabel = NonNullable<
  OneOffShipmentExecutionState['carrierGroup']
>['labels'][number]
type PackBody = {
  action: 'confirm-pack'
  orderGlobalId: string
  expectedRowVersion: number
  expectedReviewSnapshotHash: string
  confirmation: typeof ONE_OFF_PACK_CONFIRMATION
  reason: string
}
type RefreshBody = {
  action: 'refresh-packed-rates'
  orderGlobalId: string
  expectedRowVersion: number
}
type PurchaseBody = {
  action: 'purchase-group'
  orderGlobalId: string
  purchaseQuoteGlobalId: string
  selectedOfferGlobalId: string
  expectedRowVersion: number
  reason: string
  confirmation?: string
}
type VoidBody = {
  action: 'void-group'
  orderGlobalId: string
  expectedRowVersion: number
  reason: string
}
type PrintBody = {
  action: 'recover-label-print'
  expectedRecoveryAction: 'enqueue' | 'retry' | 'new_print'
  orderGlobalId: string
  expectedRowVersion: number
  packageGlobalId: string
  labelGlobalId: string
  expectedPrintJobGlobalId: string | null
  expectedPrintJobStatus: 'queued' | 'claimed' | 'delivered' | 'failed'
    | 'cancelled' | 'printed' | 'rerouted' | null
  expectedPrintArtifactGlobalId: string | null
  expectedPrintAttempts: number | null
  expectedPrintMaxAttempts: number | null
  expectedLatestAttemptSequenceNumber: number | null
  expectedLatestErrorCode: string | null
  reason: string
}

export function reconcilePackEvidenceAcknowledgment(
  acknowledgedEvidenceHash: string | null,
  previousEvidenceHash: string | null,
  nextEvidenceHash: string | null,
) {
  if (
    !acknowledgedEvidenceHash
    || acknowledgedEvidenceHash !== previousEvidenceHash
    || acknowledgedEvidenceHash !== nextEvidenceHash
  ) return null
  return acknowledgedEvidenceHash
}

export function packEvidenceIsAcknowledged(
  acknowledgedEvidenceHash: string | null,
  currentEvidenceHash: string | null,
) {
  return Boolean(
    currentEvidenceHash
    && acknowledgedEvidenceHash === currentEvidenceHash,
  )
}

function retainedCommandName(action: CommandAction, orderGlobalId: string) {
  return `clawpilot:shipping:${orderGlobalId}:${action}:command`
}

function readRetainedCommand(
  action: CommandAction,
  orderGlobalId: string,
): RetainedCommand | null {
  const storageKey = retainedCommandName(action, orderGlobalId)
  try {
    return readShippingOneOffRetainedCommand(
      window.sessionStorage,
      action,
      orderGlobalId,
      storageKey,
    )
  } catch {
    return null
  }
}

function retainCommand(
  action: CommandAction,
  orderGlobalId: string,
  expected: RetainedCommand | null,
  replacement: RetainedCommand | null,
) {
  const storageKey = retainedCommandName(action, orderGlobalId)
  try {
    return replaceShippingOneOffRetainedCommandIfExact(
      window.sessionStorage,
      storageKey,
      expected,
      replacement,
    )
  } catch {
    return false
  }
}

function newCommand(
  action: CommandAction,
  orderGlobalId: string,
  body: PackBody | RefreshBody | PurchaseBody | VoidBody | PrintBody,
): RetainedCommand {
  return {
    key: `shipping-one-off-${action}:${orderGlobalId}:${crypto.randomUUID()}`,
    body: JSON.stringify(body),
  }
}

function parsedCommandBody<T>(command: RetainedCommand | null): T | null {
  if (!command) return null
  try {
    return JSON.parse(command.body) as T
  } catch {
    return null
  }
}

export type RetainedPackReceiptDisposition = 'pending' | 'exact' | 'superseded'
export type RetainedPrintRecoveryDisposition = 'pending' | 'exact' | 'superseded'

export function retainedPrintRecoveryDisposition(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
  currentOrderGlobalId: string,
): RetainedPrintRecoveryDisposition {
  const body = parsedCommandBody<PrintBody>(command)
  if (
    !state
    || !command
    || state.orderGlobalId !== currentOrderGlobalId
    || body?.action !== 'recover-label-print'
    || !['enqueue', 'retry', 'new_print'].includes(
      body.expectedRecoveryAction,
    )
    || body.orderGlobalId !== currentOrderGlobalId
    || !body.packageGlobalId
    || !body.labelGlobalId
    || !body.reason
    || (
      body.expectedPrintJobGlobalId === null
      && (
        body.expectedRecoveryAction !== 'enqueue'
        || body.expectedPrintJobStatus !== null
        || body.expectedPrintArtifactGlobalId !== null
        || body.expectedPrintAttempts !== null
        || body.expectedPrintMaxAttempts !== null
        || body.expectedLatestAttemptSequenceNumber !== null
        || body.expectedLatestErrorCode !== null
      )
    )
    || (
      body.expectedPrintJobGlobalId !== null
      && (
        body.expectedRecoveryAction === 'enqueue'
        || body.expectedPrintJobStatus === null
        || body.expectedPrintArtifactGlobalId === null
        || !Number.isSafeInteger(body.expectedPrintAttempts)
        || !Number.isSafeInteger(body.expectedPrintMaxAttempts)
        || !Number.isSafeInteger(body.expectedLatestAttemptSequenceNumber)
        || (
          body.expectedLatestErrorCode !== null
          && typeof body.expectedLatestErrorCode !== 'string'
        )
      )
    )
  ) return 'pending'
  const group = state.carrierGroup
  const label = group?.labels.find((candidate) => (
    candidate.labelGlobalId === body.labelGlobalId
    && candidate.packageGlobalId === body.packageGlobalId
  ))
  if (!group || !label) return 'pending'
  if (!group.active || label.status !== 'created') return 'superseded'
  if (body.expectedPrintJobGlobalId === null) {
    if (!label.printJobGlobalId) return 'pending'
    return label.printJobRequestIdempotencyKey === command.key
      && label.printReprintOfJobGlobalId === null
      ? 'exact'
      : 'superseded'
  }
  if (
    label.printReprintOfJobGlobalId === body.expectedPrintJobGlobalId
  ) {
    return body.expectedRecoveryAction === 'new_print'
      && label.printJobRequestIdempotencyKey
      === `print-user:reprint:${command.key}`
      ? 'exact'
      : 'superseded'
  }
  if (label.printJobGlobalId !== body.expectedPrintJobGlobalId) {
    return label.printJobGlobalId ? 'superseded' : 'pending'
  }
  if (
    body.expectedRecoveryAction === 'retry'
    && label.printOperatorRetryIdempotencyKeys.includes(
      `print-user:retry:${command.key}`,
    )
  ) return 'exact'
  return label.printJobStatus !== body.expectedPrintJobStatus
    ? 'superseded'
    : 'pending'
}

export function printRecoveryResponseMatchesDurableState(
  result: unknown,
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
  currentOrderGlobalId: string,
): result is OneOffShippingPrintRecoveryResult {
  if (
    retainedPrintRecoveryDisposition(state, command, currentOrderGlobalId)
      !== 'exact'
    || !result
    || typeof result !== 'object'
  ) return false
  const body = parsedCommandBody<PrintBody>(command)
  const group = state?.carrierGroup
  const label = group?.labels.find((candidate) => (
    candidate.labelGlobalId === body?.labelGlobalId
    && candidate.packageGlobalId === body?.packageGlobalId
  ))
  if (!body || !group?.active || !label || label.status !== 'created') {
    return false
  }
  const candidate = result as Partial<OneOffShippingPrintRecoveryResult>
  const expectedAction = body.expectedRecoveryAction
  const expectedSourcePrintJobGlobalId = expectedAction === 'enqueue'
    ? null
    : body.expectedPrintJobGlobalId
  return candidate.orderGlobalId === currentOrderGlobalId
    && candidate.packageGlobalId === body.packageGlobalId
    && candidate.labelGlobalId === body.labelGlobalId
    && candidate.action === expectedAction
    && candidate.printJobGlobalId === label.printJobGlobalId
    && candidate.sourcePrintJobGlobalId === expectedSourcePrintJobGlobalId
    && candidate.printArtifactGlobalId === label.printArtifactGlobalId
    && candidate.printContentSha256 === label.printContentSha256
    && candidate.printByteLength === label.printByteLength
    && candidate.printMaxAttempts === label.printMaxAttempts
    && candidate.effects?.carrierWrites === 0
    && candidate.effects?.providerWrites === 0
    && candidate.effects?.labelWrites === 0
}

export function retainedPackReceiptDisposition(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
  currentOrderGlobalId: string,
): RetainedPackReceiptDisposition {
  const body = parsedCommandBody<PackBody>(command)
  const receipt = state?.packReview.receipt
  if (
    !state
    || !command
    || state.orderGlobalId !== currentOrderGlobalId
    || body?.action !== 'confirm-pack'
    || body.orderGlobalId !== currentOrderGlobalId
    || !/^[a-f0-9]{64}$/.test(body.expectedReviewSnapshotHash)
    || state.orderStatus !== 'packed'
    || state.packReview.state !== 'packed'
    || state.packReview.required
    || state.packReview.evidenceHash !== null
    || !receipt
    || receipt.packageCount !== state.packageCount
    || !/^[a-f0-9]{64}$/.test(receipt.reviewSnapshotHash)
    || typeof receipt.requestIdempotencyKey !== 'string'
    || receipt.requestIdempotencyKey.length < 8
  ) return 'pending'
  if (receipt.requestIdempotencyKey !== command.key) return 'superseded'
  return receipt.reviewSnapshotHash === body.expectedReviewSnapshotHash
    ? 'exact'
    : 'pending'
}

async function readPayload(response: Response) {
  const raw = await response.text()
  try {
    return {
      malformed: false,
      payload: JSON.parse(raw) as ExecutionPayload,
    }
  } catch {
    return { malformed: true, payload: {} as ExecutionPayload }
  }
}

function definitiveClientRejection(response: Response, malformed: boolean) {
  return shippingOneOffResponseIsDefinitiveClientRejection(
    response.status,
    malformed,
  )
}

function payloadMessage(payload: ExecutionPayload, fallback: string) {
  return `${payload.error || fallback}${payload.code ? ` [${payload.code}]` : ''}`
}

function money(minor: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  }).format(minor / 100)
}

function refreshIsDurable(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
) {
  const body = parsedCommandBody<RefreshBody>(command)
  return Boolean(
    state
    && command
    && body?.action === 'refresh-packed-rates'
    && body.orderGlobalId === state.orderGlobalId
    && state.packedRate?.requestIdempotencyKey === command.key,
  )
}

function packIsDurable(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
  currentOrderGlobalId: string,
) {
  return retainedPackReceiptDisposition(
    state,
    command,
    currentOrderGlobalId,
  ) === 'exact'
}

function purchaseIsDurable(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
) {
  return purchaseIsBoundToGroup(state, command)
    && state?.carrierGroup?.state === 'succeeded'
}

function purchaseIsBoundToGroup(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
) {
  const body = parsedCommandBody<PurchaseBody>(command)
  const group = state?.carrierGroup
  return Boolean(
    state
    && command
    && body?.action === 'purchase-group'
    && body.orderGlobalId === state.orderGlobalId
    && group?.createRequestIdempotencyKey === command.key
    && group.purchaseQuoteGlobalId === body.purchaseQuoteGlobalId
    && group.purchaseOfferGlobalId === body.selectedOfferGlobalId,
  )
}

function voidIsDurable(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
) {
  return voidIsBoundToGroup(state, command)
    && state?.carrierGroup?.voidState === 'succeeded'
}

function voidIsBoundToGroup(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
) {
  const body = parsedCommandBody<VoidBody>(command)
  const group = state?.carrierGroup
  return Boolean(
    state
    && command
    && body?.action === 'void-group'
    && body.orderGlobalId === state.orderGlobalId
    && group?.voidRequestIdempotencyKey === command.key,
  )
}

export default function ShippingOneOffExecutionPanel({
  orderGlobalId,
  canPurchaseLivePostage,
  onUpdated,
}: {
  orderGlobalId: string
  canPurchaseLivePostage: boolean
  onUpdated: () => void | Promise<void>
}) {
  const [state, setState] = useState<OneOffShipmentExecutionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<
    'pack' | 'refresh' | 'purchase' | 'void' | 'print' | ''
  >('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedOfferGlobalId, setSelectedOfferGlobalId] = useState('')
  const [purchaseReason, setPurchaseReason] = useState(
    'Create labels for the reviewed current rate and exact packed one-off parcels',
  )
  const [packReason, setPackReason] = useState(
    'Physically reviewed every item and confirmed the exact package contents',
  )
  const [packConfirmedEvidenceHash, setPackConfirmedEvidenceHash] =
    useState<string | null>(null)
  const [voidReason, setVoidReason] = useState(
    'Cancel the exact complete one-off carrier shipment before shipment confirmation',
  )
  const [printReason, setPrintReason] = useState(
    'Recover this exact existing label on the current approved Shipping printer route',
  )
  const [liveConfirmed, setLiveConfirmed] = useState(false)
  const [packCommand, setPackCommand] = useState<RetainedCommand | null>(null)
  const [refreshCommand, setRefreshCommand] = useState<RetainedCommand | null>(null)
  const [purchaseCommand, setPurchaseCommand] = useState<RetainedCommand | null>(null)
  const [voidCommand, setVoidCommand] = useState<RetainedCommand | null>(null)
  const [printCommand, setPrintCommand] = useState<RetainedCommand | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const packEvidenceHashRef = useRef<string | null>(null)
  const componentMountedRef = useRef(false)
  const loadStateEpochRef = useRef(0)
  const executionOrderFenceRef = useRef<ExecutionOrderFence>({
    orderGlobalId,
    generation: 0,
  })
  if (executionOrderFenceRef.current.orderGlobalId !== orderGlobalId) {
    executionOrderFenceRef.current = {
      orderGlobalId,
      generation: executionOrderFenceRef.current.generation + 1,
    }
  }
  const executionOrderFence = executionOrderFenceRef.current
  useEffect(() => {
    componentMountedRef.current = true
    return () => {
      componentMountedRef.current = false
      loadStateEpochRef.current += 1
    }
  }, [])
  const requestFenceIsCurrent = useCallback((request: ExecutionOrderFence) => (
    mountedExecutionOrderFenceIsCurrent(
      componentMountedRef.current,
      request,
      executionOrderFenceRef.current,
    )
  ), [])

  const clearPackCommand = useCallback((expected: RetainedCommand) => {
    if (!retainCommand('pack', orderGlobalId, expected, null)) return
    setPackCommand((current) => (
      shippingOneOffRetainedCommandsMatch(current, expected) ? null : current
    ))
  }, [orderGlobalId])

  const clearRefreshCommand = useCallback((expected: RetainedCommand) => {
    if (!retainCommand('packed-rate', orderGlobalId, expected, null)) return
    setRefreshCommand((current) => (
      shippingOneOffRetainedCommandsMatch(current, expected) ? null : current
    ))
  }, [orderGlobalId])
  const clearPurchaseCommand = useCallback((expected: RetainedCommand) => {
    if (!retainCommand('purchase', orderGlobalId, expected, null)) return
    setPurchaseCommand((current) => (
      shippingOneOffRetainedCommandsMatch(current, expected) ? null : current
    ))
  }, [orderGlobalId])
  const clearVoidCommand = useCallback((expected: RetainedCommand) => {
    if (!retainCommand('void', orderGlobalId, expected, null)) return
    setVoidCommand((current) => (
      shippingOneOffRetainedCommandsMatch(current, expected) ? null : current
    ))
  }, [orderGlobalId])
  const clearPrintCommand = useCallback((expected: RetainedCommand) => {
    if (!retainCommand('print', orderGlobalId, expected, null)) return
    setPrintCommand((current) => (
      shippingOneOffRetainedCommandsMatch(current, expected) ? null : current
    ))
  }, [orderGlobalId])

  const loadState = useCallback(async () => {
    const requestFence = executionOrderFence
    const requestEpoch = loadStateEpochRef.current + 1
    loadStateEpochRef.current = requestEpoch
    const requestIsCurrent = () => executionStateLoadIsCurrent(
      componentMountedRef.current,
      requestFence,
      executionOrderFenceRef.current,
      requestEpoch,
      loadStateEpochRef.current,
    )
    if (!requestIsCurrent()) return null
    setLoading(true)
    try {
      const response = await fetch(
        `/api/operations/one-off-shipments?orderGlobalId=${encodeURIComponent(orderGlobalId)}`,
        { cache: 'no-store' },
      )
      if (!requestIsCurrent()) return null
      const { malformed, payload } = await readPayload(response)
      if (!requestIsCurrent()) return null
      if (
        malformed
        || !response.ok
        || !payload.ok
        || !payload.state
        || payload.state.orderGlobalId !== orderGlobalId
      ) {
        throw new Error(payloadMessage(payload, 'One-off postage status is unavailable'))
      }
      const nextEvidenceHash = payload.state.packReview.evidenceHash || null
      setPackConfirmedEvidenceHash((acknowledgedEvidenceHash) => (
        reconcilePackEvidenceAcknowledgment(
          acknowledgedEvidenceHash,
          packEvidenceHashRef.current,
          nextEvidenceHash,
        )
      ))
      packEvidenceHashRef.current = nextEvidenceHash
      setState(payload.state)
      setClock(Date.now())
      return payload.state
    } catch (caught) {
      if (!requestIsCurrent()) return null
      setError(caught instanceof Error
        ? caught.message
        : 'One-off postage status is unavailable')
      return null
    } finally {
      if (requestIsCurrent()) setLoading(false)
    }
  }, [executionOrderFence, orderGlobalId])

  useEffect(() => {
    setState(null)
    setBusy('')
    setError('')
    setNotice('')
    setSelectedOfferGlobalId('')
    setPackConfirmedEvidenceHash(null)
    packEvidenceHashRef.current = null
    setLiveConfirmed(false)
    setPackCommand(readRetainedCommand('pack', orderGlobalId))
    setRefreshCommand(readRetainedCommand('packed-rate', orderGlobalId))
    setPurchaseCommand(readRetainedCommand('purchase', orderGlobalId))
    setVoidCommand(readRetainedCommand('void', orderGlobalId))
    setPrintCommand(readRetainedCommand('print', orderGlobalId))
    void loadState()
  }, [loadState, orderGlobalId])

  useEffect(() => {
    if (state?.orderGlobalId !== orderGlobalId) return
    const packDisposition = retainedPackReceiptDisposition(
      state,
      packCommand,
      orderGlobalId,
    )
    if (packDisposition !== 'pending') {
      if (packCommand) clearPackCommand(packCommand)
      if (packDisposition === 'superseded') {
        setNotice(
          'Another immutable physical pack receipt completed this order. '
          + 'The older retained request was retired without replay; postage controls are ready.',
        )
      }
    }
    if (refreshCommand && refreshIsDurable(state, refreshCommand)) {
      clearRefreshCommand(refreshCommand)
    }
    if (purchaseCommand && purchaseIsDurable(state, purchaseCommand)) {
      clearPurchaseCommand(purchaseCommand)
    }
    if (voidCommand && voidIsDurable(state, voidCommand)) {
      clearVoidCommand(voidCommand)
    }
    const printDisposition = retainedPrintRecoveryDisposition(
      state,
      printCommand,
      orderGlobalId,
    )
    if (
      printDisposition !== 'pending'
      && !(
        printDisposition === 'exact'
        && printCommand?.responseBindingRequired
      )
    ) {
      if (printCommand) clearPrintCommand(printCommand)
      setNotice(printDisposition === 'exact'
        ? 'The exact label print recovery is durably queued; current status is shown below.'
        : 'Another authoritative label or print transition superseded the retained request. Current status is shown below.')
    }
  }, [
    clearPackCommand,
    clearPurchaseCommand,
    clearRefreshCommand,
    clearVoidCommand,
    clearPrintCommand,
    orderGlobalId,
    packCommand,
    purchaseCommand,
    printCommand,
    refreshCommand,
    state,
    voidCommand,
  ])

  const currentState = state?.orderGlobalId === orderGlobalId ? state : null
  const sortedOffers = useMemo(() => (
    [...(currentState?.packedRate?.offers || [])].sort((left, right) => (
      left.amountMinor - right.amountMinor
    ))
  ), [currentState?.packedRate?.offers])

  useEffect(() => {
    if (!sortedOffers.length) {
      setSelectedOfferGlobalId('')
      return
    }
    if (!sortedOffers.some((offer) => offer.globalId === selectedOfferGlobalId)) {
      const executable = sortedOffers.find((offer) => (
        offer.executionCapability === 'direct_purchase_later'
      ))
      setSelectedOfferGlobalId(executable?.globalId || '')
    }
  }, [selectedOfferGlobalId, sortedOffers])

  const expiresAt = currentState?.packedRate
    ? new Date(currentState.packedRate.expiresAt).getTime()
    : 0
  useEffect(() => {
    if (!expiresAt || expiresAt <= clock) return
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.min(expiresAt - clock + 25, 2_147_483_647),
    )
    return () => window.clearTimeout(timer)
  }, [clock, expiresAt])

  const group = currentState?.carrierGroup || null
  const retainedPrintBody = parsedCommandBody<PrintBody>(printCommand)
  const live = currentState?.executionMode === 'live'
  const liveAllowed = !live || canPurchaseLivePostage
  const unresolved = group?.unresolved === true
  const retryingUnresolvedPurchase = Boolean(
    purchaseIsBoundToGroup(state, purchaseCommand)
    && group
    && (group.state === 'prepared' || group.state === 'unknown'),
  )
  const retryingUnresolvedVoid = Boolean(
    voidIsBoundToGroup(state, voidCommand)
    && group
    && (group.voidState === 'prepared' || group.voidState === 'unknown'),
  )
  const packedRateCurrent = Boolean(
    currentState?.packedRate
    && !currentState.packedRate.consumed
    && currentState.packedRate.status !== 'failed'
    && expiresAt > clock,
  )
  const packEvidenceHash = currentState?.packReview.evidenceHash || null
  const packConfirmed = packEvidenceIsAcknowledged(
    packConfirmedEvidenceHash,
    packEvidenceHash,
  )

  const confirmPack = async () => {
    const requestFence = executionOrderFence
    const requestIsCurrent = () => requestFenceIsCurrent(requestFence)
    if (
      !requestIsCurrent()
      || !state
      || state.orderGlobalId !== orderGlobalId
      || busy
      || !state.packReview.required
      || (!packCommand && !state.packReview.evidenceHash)
      || (!packCommand && !packConfirmed)
      || (!packCommand && packReason.trim().length < 10)
      || refreshCommand
      || purchaseCommand
      || voidCommand
      || printCommand
    ) return
    const command = packCommand || newCommand('pack', orderGlobalId, {
      action: 'confirm-pack',
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
      expectedReviewSnapshotHash: state.packReview.evidenceHash!,
      confirmation: ONE_OFF_PACK_CONFIRMATION,
      reason: packReason.trim(),
    })
    if (!retainCommand('pack', orderGlobalId, packCommand, command)) {
      setError('Browser retry storage is unavailable. No pack confirmation was sent.')
      return
    }
    setPackCommand(command)
    setBusy('pack')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.key,
        },
        body: command.body,
      })
      if (!requestIsCurrent()) return
      const { malformed, payload } = await readPayload(response)
      if (!requestIsCurrent()) return
      const validResult = Boolean(
        response.ok
        && payload.ok
        && payload.result
        && 'reviewSnapshotHash' in payload.result
        && payload.result.orderGlobalId === orderGlobalId,
      )
      if (!validResult) {
        if (definitiveClientRejection(response, malformed)) {
          const durable = await loadState()
          if (!requestIsCurrent()) return
          if (!durable) {
            throw new Error('The rejected pack confirmation could not be reconciled to durable status')
          }
          if (packIsDurable(durable, command, orderGlobalId)) {
            clearPackCommand(command)
            setPackConfirmedEvidenceHash(null)
            setNotice('The prior exact physical pack confirmation succeeded. Current postage controls are ready.')
            if (!requestIsCurrent()) return
            await onUpdated()
            return
          }
          if (
            retainedPackReceiptDisposition(
              durable,
              command,
              orderGlobalId,
            ) === 'superseded'
          ) {
            clearPackCommand(command)
            setError('')
            setNotice(
              'Another immutable physical pack receipt completed this order. '
              + 'The older retained request was retired without replay; postage controls are ready.',
            )
            if (!requestIsCurrent()) return
            await onUpdated()
            return
          }
          clearPackCommand(command)
          setError(
            `${payloadMessage(payload, 'The physical pack confirmation was rejected')} `
            + 'Refresh and physically review the exact current evidence before trying again.',
          )
          return
        }
        throw new Error(payloadMessage(payload, 'The exact physical pack confirmation did not complete'))
      }
      const result = payload.result as OneOffShippingPackCommandResult
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (
        !packIsDurable(durable, command, orderGlobalId)
        || durable?.packReview.receipt?.reviewSnapshotHash
          !== result.reviewSnapshotHash
      ) {
        throw new Error('The pack response is not yet bound to the exact durable review receipt')
      }
      clearPackCommand(command)
      setPackConfirmedEvidenceHash(null)
      setNotice(
        `${result.packageCount} ${result.packageCount === 1 ? 'parcel is' : 'parcels are'} `
        + 'packed with reservations retained and zero carrier or label writes.',
      )
      if (!requestIsCurrent()) return
      await onUpdated()
    } catch (caught) {
      if (!requestIsCurrent()) return
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (packIsDurable(durable, command, orderGlobalId)) {
        clearPackCommand(command)
        setPackConfirmedEvidenceHash(null)
        setNotice('The prior exact physical pack confirmation succeeded. Current postage controls are ready.')
        if (!requestIsCurrent()) return
        await onUpdated()
      } else if (
        retainedPackReceiptDisposition(
          durable,
          command,
          orderGlobalId,
        ) === 'superseded'
      ) {
        clearPackCommand(command)
        setError('')
        setNotice(
          'Another immutable physical pack receipt completed this order. '
          + 'The older retained request was retired without replay; postage controls are ready.',
        )
        if (!requestIsCurrent()) return
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact physical pack confirmation did not complete'}. `
          + 'Check status or retry the retained byte-identical request; do not create a new confirmation.',
        )
      }
    } finally {
      if (requestIsCurrent()) setBusy('')
    }
  }

  const refreshRates = async () => {
    const requestFence = executionOrderFence
    const requestIsCurrent = () => requestFenceIsCurrent(requestFence)
    if (
      !requestIsCurrent()
      || !state
      || state.orderGlobalId !== orderGlobalId
      || busy
      || !liveAllowed
      || unresolved
      || packCommand
      || purchaseCommand
      || voidCommand
      || printCommand
    ) return
    const command = refreshCommand || newCommand('packed-rate', orderGlobalId, {
      action: 'refresh-packed-rates',
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
    })
    if (!retainCommand(
      'packed-rate', orderGlobalId, refreshCommand, command,
    )) {
      setError('Browser retry storage is unavailable. No carrier rate request was sent.')
      return
    }
    setRefreshCommand(command)
    setBusy('refresh')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.key,
        },
        body: command.body,
      })
      if (!requestIsCurrent()) return
      const { malformed, payload } = await readPayload(response)
      if (!requestIsCurrent()) return
      const validResult = Boolean(
        response.ok
        && payload.ok
        && payload.result
        && 'quote' in payload.result
        && payload.result.orderGlobalId === orderGlobalId,
      )
      if (!validResult) {
        if (definitiveClientRejection(response, malformed)) {
          const durable = await loadState()
          if (!requestIsCurrent()) return
          if (!durable) {
            throw new Error('The rejected packed-rate request could not be reconciled to durable status')
          }
          if (refreshIsDurable(durable, command)) {
            clearRefreshCommand(command)
            setNotice('The prior exact packed-rate request succeeded; durable rates are current.')
            return
          }
          clearRefreshCommand(command)
          setError(
            `${payloadMessage(payload, 'Current packed rates were rejected')} `
            + 'The rejected request was not retained; review the current status before trying again.',
          )
          return
        }
        throw new Error(payloadMessage(payload, 'Current packed rates did not return a complete response'))
      }
      const result = payload.result as OneOffPackedRateRefresh
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (
        !refreshIsDurable(durable, command)
        || durable?.packedRate?.quoteGlobalId !== result.quote.globalId
      ) {
        throw new Error('The packed-rate response is not yet bound to the exact durable request')
      }
      clearRefreshCommand(command)
      setNotice(
        `${result.quote.offers.length} current ${result.executionMode.toUpperCase()} `
        + `${result.quote.offers.length === 1 ? 'rate is' : 'rates are'} ready.`,
      )
    } catch (caught) {
      if (!requestIsCurrent()) return
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (refreshIsDurable(durable, command)) {
        clearRefreshCommand(command)
        setNotice('The prior exact packed-rate request succeeded; durable rates are current.')
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'Current packed rates did not complete'}. `
          + 'The byte-identical request and key are retained; check status or retry this exact request.',
        )
      }
    } finally {
      if (requestIsCurrent()) setBusy('')
    }
  }

  const purchaseLabels = async () => {
    const requestFence = executionOrderFence
    const requestIsCurrent = () => requestFenceIsCurrent(requestFence)
    if (
      !requestIsCurrent()
      || !state
      || state.orderGlobalId !== orderGlobalId
      || busy
      || !liveAllowed
      || Boolean(packCommand || refreshCommand || voidCommand || printCommand)
      || (!purchaseCommand && !packedRateCurrent)
      || (!purchaseCommand && !state.packedRate)
      || (!purchaseCommand && !selectedOfferGlobalId)
      || (!purchaseCommand && purchaseReason.trim().length < 10)
      || (live && !liveConfirmed)
    ) return
    const command = purchaseCommand || newCommand('purchase', orderGlobalId, {
      action: 'purchase-group',
      orderGlobalId,
      purchaseQuoteGlobalId: state.packedRate!.quoteGlobalId,
      selectedOfferGlobalId,
      expectedRowVersion: state.rowVersion,
      reason: purchaseReason.trim(),
      ...(live ? { confirmation: ONE_OFF_LIVE_POSTAGE_CONFIRMATION } : {}),
    })
    if (!retainCommand(
      'purchase', orderGlobalId, purchaseCommand, command,
    )) {
      setError('Browser retry storage is unavailable. No carrier label request was sent.')
      return
    }
    setPurchaseCommand(command)
    setBusy('purchase')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.key,
        },
        body: command.body,
      })
      if (!requestIsCurrent()) return
      const { malformed, payload } = await readPayload(response)
      if (!requestIsCurrent()) return
      const validResult = Boolean(
        response.ok
        && payload.ok
        && payload.result
        && 'groupAttemptGlobalId' in payload.result
        && payload.result.action === 'create'
        && payload.result.orderGlobalId === orderGlobalId,
      )
      if (!validResult) {
        if (definitiveClientRejection(response, malformed)) {
          const durable = await loadState()
          if (!requestIsCurrent()) return
          if (!durable) {
            throw new Error('The rejected label request could not be reconciled to durable status')
          }
          if (purchaseIsDurable(durable, command)) {
            clearPurchaseCommand(command)
            setLiveConfirmed(false)
            setNotice('The prior exact label request succeeded; its durable labels are shown below.')
            if (!requestIsCurrent()) return
            await onUpdated()
            return
          }
          clearPurchaseCommand(command)
          setError(
            `${payloadMessage(payload, 'The carrier label request was rejected')} `
            + 'The rejected request was not retained; review the current quote and status before trying again.',
          )
          return
        }
        throw new Error(payloadMessage(payload, 'The exact carrier label request did not complete'))
      }
      const result = payload.result as OneOffCarrierGroupCommandResult
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (
        !purchaseIsDurable(durable, command)
        || durable?.carrierGroup?.createAttemptGlobalId !== result.groupAttemptGlobalId
      ) {
        throw new Error('The label response is not yet bound to the exact order, quote, offer, and request key')
      }
      clearPurchaseCommand(command)
      setLiveConfirmed(false)
      setNotice(
        `${result.executionMode.toUpperCase()} carrier group `
        + `${result.groupAttemptGlobalId} returned ${result.labels.length} `
        + `${result.labels.length === 1 ? 'label' : 'labels'}.`,
      )
      if (!requestIsCurrent()) return
      await onUpdated()
    } catch (caught) {
      if (!requestIsCurrent()) return
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (purchaseIsDurable(durable, command)) {
        clearPurchaseCommand(command)
        setLiveConfirmed(false)
        setNotice('The prior exact label request succeeded; its durable labels are shown below.')
        if (!requestIsCurrent()) return
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact carrier label request did not complete'}. `
          + 'Do not start a new request. Check durable status or retry the retained byte-identical request.',
        )
      }
    } finally {
      if (requestIsCurrent()) setBusy('')
    }
  }

  const recoverLabelPrint = async (selectedLabel: ExecutionLabel) => {
    const requestFence = executionOrderFence
    const requestIsCurrent = () => requestFenceIsCurrent(requestFence)
    const retainedBody = parsedCommandBody<PrintBody>(printCommand)
    const label = printCommand
      ? group?.labels.find((candidate) => (
        candidate.labelGlobalId === retainedBody?.labelGlobalId
        && candidate.packageGlobalId === retainedBody?.packageGlobalId
      )) || null
      : selectedLabel
    if (
      !requestIsCurrent()
      || !state
      || state.orderGlobalId !== orderGlobalId
      || (printCommand && retainedBody?.orderGlobalId !== orderGlobalId)
      || !group?.active
      || !label
      || label.status !== 'created'
      || busy
      || packCommand
      || refreshCommand
      || purchaseCommand
      || voidCommand
      || (!printCommand && !label.printRecoveryAction)
      || (!printCommand && printReason.trim().length < 10)
    ) return
    const command = printCommand || newCommand('print', orderGlobalId, {
      action: 'recover-label-print',
      expectedRecoveryAction: label.printRecoveryAction!,
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
      packageGlobalId: label.packageGlobalId,
      labelGlobalId: label.labelGlobalId,
      expectedPrintJobGlobalId: label.printJobGlobalId,
      expectedPrintJobStatus: label.printJobStatus,
      expectedPrintArtifactGlobalId: label.printArtifactGlobalId,
      expectedPrintAttempts: label.printAttempts,
      expectedPrintMaxAttempts: label.printMaxAttempts,
      expectedLatestAttemptSequenceNumber:
        label.printLatestAttemptSequenceNumber,
      expectedLatestErrorCode: label.printLatestErrorCode,
      reason: printReason.trim(),
    })
    if (!retainCommand('print', orderGlobalId, printCommand, command)) {
      setError('Browser retry storage is unavailable. No label print recovery was sent.')
      return
    }
    setPrintCommand(command)
    setBusy('print')
    setError('')
    setNotice('')
    const retainUntilResponseIsBound = () => {
      if (!requestIsCurrent()) return
      const guardedCommand: RetainedCommand = {
        ...command,
        responseBindingRequired: true,
      }
      if (retainCommand('print', orderGlobalId, command, guardedCommand)) {
        setPrintCommand((current) => (
          shippingOneOffRetainedCommandsMatch(current, command)
            ? guardedCommand
            : current
        ))
      }
    }
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.key,
        },
        body: command.body,
      })
      if (!requestIsCurrent()) return
      const { malformed, payload } = await readPayload(response)
      if (!requestIsCurrent()) return
      const validResult = Boolean(
        response.ok
        && payload.ok
        && payload.result
        && typeof payload.result === 'object'
        && payload.result.orderGlobalId === orderGlobalId,
      )
      if (!validResult) {
        if (definitiveClientRejection(response, malformed)) {
          const durable = await loadState()
          if (!requestIsCurrent()) return
          if (!durable) {
            throw new Error('The rejected print recovery could not be reconciled to durable status')
          }
          const disposition = retainedPrintRecoveryDisposition(
            durable,
            command,
            orderGlobalId,
          )
          if (disposition !== 'pending') {
            clearPrintCommand(command)
            setNotice(disposition === 'exact'
              ? 'The prior exact label print recovery succeeded; current status is shown below.'
              : 'Another authoritative label or print transition superseded the retained request; current status is shown below.')
            if (!requestIsCurrent()) return
            await onUpdated()
            return
          }
          clearPrintCommand(command)
          setError(
            `${payloadMessage(payload, 'Label print recovery was rejected')} `
            + 'Refresh the exact label and print status before deciding whether another physical print is safe.',
          )
          return
        }
        if (response.ok) {
          retainUntilResponseIsBound()
          setError(
            'The successful print response was malformed and was not bound to the exact durable label. '
            + 'The retained byte-identical request was preserved for safe reconciliation.',
          )
          return
        }
        throw new Error(payloadMessage(payload, 'The exact label print recovery did not complete'))
      }
      const result = payload.result
      // A successful response is not authoritative until it is bound back to
      // the exact durable job and immutable artifact. Persist that guard before
      // loadState publishes newer state so the reconciliation effect cannot
      // clear these byte-identical retry bytes in between the GET and binding.
      retainUntilResponseIsBound()
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (!printRecoveryResponseMatchesDurableState(
        result,
        durable,
        command,
        orderGlobalId,
      )) {
        setError(
          'The successful print response does not match the exact durable job, artifact, label, action, or zero-write evidence. '
          + 'The retained byte-identical request was preserved for safe reconciliation.',
        )
        return
      }
      clearPrintCommand(command)
      setNotice(
        result.action === 'enqueue'
          ? 'The existing immutable label is queued with zero carrier, provider, or label writes.'
          : result.action === 'retry'
            ? 'The exact retry-safe failed print job is queued again; no carrier label was purchased.'
            : 'A new print with immutable lineage is queued after the exact retry-safe job exhausted its attempts.',
      )
      if (!requestIsCurrent()) return
      await onUpdated()
    } catch (caught) {
      if (!requestIsCurrent()) return
      const durable = await loadState()
      if (!requestIsCurrent()) return
      const disposition = retainedPrintRecoveryDisposition(
        durable,
        command,
        orderGlobalId,
      )
      if (disposition !== 'pending') {
        clearPrintCommand(command)
        setError('')
        setNotice(disposition === 'exact'
          ? 'The prior exact label print recovery succeeded; current status is shown below.'
          : 'Another authoritative label or print transition superseded the retained request; current status is shown below.')
        if (!requestIsCurrent()) return
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact label print recovery did not complete'}. `
          + 'Check status or retry the retained byte-identical request; do not authorize another physical print.',
        )
      }
    } finally {
      if (requestIsCurrent()) setBusy('')
    }
  }

  const voidLabels = async () => {
    const requestFence = executionOrderFence
    const requestIsCurrent = () => requestFenceIsCurrent(requestFence)
    if (
      !requestIsCurrent()
      || !state
      || state.orderGlobalId !== orderGlobalId
      || (!group?.active && !retryingUnresolvedVoid)
      || busy
      || !liveAllowed
      || Boolean(packCommand || refreshCommand || purchaseCommand || printCommand)
      || (!voidCommand && voidReason.trim().length < 10)
    ) return
    const command = voidCommand || newCommand('void', orderGlobalId, {
      action: 'void-group',
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
      reason: voidReason.trim(),
    })
    if (!retainCommand('void', orderGlobalId, voidCommand, command)) {
      setError('Browser retry storage is unavailable. No carrier cancellation was sent.')
      return
    }
    setVoidCommand(command)
    setBusy('void')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations/one-off-shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.key,
        },
        body: command.body,
      })
      if (!requestIsCurrent()) return
      const { malformed, payload } = await readPayload(response)
      if (!requestIsCurrent()) return
      const validResult = Boolean(
        response.ok
        && payload.ok
        && payload.result
        && 'groupAttemptGlobalId' in payload.result
        && payload.result.action !== 'create'
        && payload.result.orderGlobalId === orderGlobalId,
      )
      if (!validResult) {
        if (definitiveClientRejection(response, malformed)) {
          const durable = await loadState()
          if (!requestIsCurrent()) return
          if (!durable) {
            throw new Error('The rejected cancellation could not be reconciled to durable status')
          }
          if (voidIsDurable(durable, command)) {
            clearVoidCommand(command)
            setNotice('The prior exact cancellation succeeded; durable status is current.')
            if (!requestIsCurrent()) return
            await onUpdated()
            return
          }
          clearVoidCommand(command)
          setError(
            `${payloadMessage(payload, 'The carrier cancellation was rejected')} `
            + 'The rejected request was not retained; review the current group before trying again.',
          )
          return
        }
        throw new Error(payloadMessage(payload, 'The exact carrier cancellation did not complete'))
      }
      const result = payload.result as OneOffCarrierGroupCommandResult
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (
        !voidIsDurable(durable, command)
        || durable?.carrierGroup?.voidAttemptGlobalId !== result.groupAttemptGlobalId
      ) {
        throw new Error('The cancellation response is not yet bound to the exact carrier group and request key')
      }
      clearVoidCommand(command)
      setNotice(
        result.action === 'close_sample'
          ? 'The complete TEST sample label group was closed locally with zero provider writes.'
          : 'The complete carrier label group was voided.',
      )
      if (!requestIsCurrent()) return
      await onUpdated()
    } catch (caught) {
      if (!requestIsCurrent()) return
      const durable = await loadState()
      if (!requestIsCurrent()) return
      if (voidIsDurable(durable, command)) {
        clearVoidCommand(command)
        setNotice('The prior exact cancellation succeeded; durable status is current.')
        if (!requestIsCurrent()) return
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact carrier cancellation did not complete'}. `
          + 'Do not create a new cancellation. Check status or retry the retained byte-identical request.',
        )
      }
    } finally {
      if (requestIsCurrent()) setBusy('')
    }
  }

  if (!currentState) {
    return (
      <Typography color={loading ? 'text.secondary' : 'error'}>
        {loading
          ? 'Loading exact postage status…'
          : error || 'Exact one-off postage status is unavailable.'}
      </Typography>
    )
  }

  return (
    <Stack spacing={1.5} data-testid="shipping-one-off-execution-panel">
      <Stack direction="row" gap={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip
          size="small"
          color={live ? 'warning' : 'success'}
          label={live ? 'LIVE production' : 'TEST sandbox'}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`${state?.packageCount || 0} ${state?.orderStatus === 'planned' ? 'planned' : 'packed'} parcel${state?.packageCount === 1 ? '' : 's'}`}
        />
        <Button
          size="small"
          startIcon={<RefreshRounded />}
          disabled={Boolean(busy) || loading}
          onClick={() => {
            if (!requestFenceIsCurrent(executionOrderFence)) return
            setError('')
            void loadState()
          }}
        >
          Check status
        </Button>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}
      {!liveAllowed && (
        <Alert severity="warning">
          Live-postage permission is required for production rates, labels, and cancellation.
        </Alert>
      )}
      {unresolved && (
        <Alert severity="warning">
          Carrier outcome is unresolved. Check status and use only the retained exact request; a new provider request is fenced.
        </Alert>
      )}
      {(packCommand || refreshCommand || purchaseCommand || voidCommand
        || printCommand) && (
        <Alert severity="info" data-testid="shipping-retained-exact-request">
          An ambiguous request retains its byte-identical body and Idempotency-Key. Editing fields does not change that retry; a definitive 4xx rejection clears it and requires fresh review.
        </Alert>
      )}
      {state?.packReview.receipt && (
        <Alert severity="success">
          Physical pack confirmed {new Date(state.packReview.receipt.packedAt).toLocaleString()} from immutable review evidence. Inventory reservations remain retained until shipment confirmation.
        </Alert>
      )}

      {state?.orderStatus === 'planned' ? (
        <Stack spacing={1.5} data-testid="shipping-one-off-pack-review">
          <Alert severity="info">
            Physically review every item and assigned parcel below. Confirming pack retains the exact inventory reservations and makes zero carrier, postage, label, shipment, or inventory writes.
          </Alert>
          {state.packReview.blocker && (
            <Alert severity="warning">{state.packReview.blocker}</Alert>
          )}
          <Box>
            <Typography fontWeight={750}>Items to pack</Typography>
            {state.packReview.lines.map((line) => (
              <Typography key={line.lineKey} variant="body2">
                {line.quantity} × {line.name}
                {line.sku ? ` · ${line.sku}` : ''}
                {` · ${line.kind === 'new' ? 'new Product' : line.kind === 'existing' ? 'existing inventory' : 'ad-hoc item'}`}
              </Typography>
            ))}
          </Box>
          <Box>
            <Typography fontWeight={750}>Exact parcels</Typography>
            {state.packReview.packages.map((oneOffPackage) => (
              <Box key={oneOffPackage.globalId} sx={{ mt: 0.75 }}>
                <Typography variant="body2" fontWeight={650}>
                  Parcel {oneOffPackage.packageNumber} · {oneOffPackage.description}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {oneOffPackage.dimensionsMm.length} × {oneOffPackage.dimensionsMm.width} × {oneOffPackage.dimensionsMm.height} mm · {oneOffPackage.grossWeightGrams} g
                </Typography>
                {oneOffPackage.contents.map((content) => {
                  const line = state.packReview.lines.find(
                    (candidate) => candidate.lineKey === content.lineKey,
                  )
                  return (
                    <Typography key={content.lineKey} variant="body2" sx={{ pl: 1.5 }}>
                      {content.quantity} × {line?.name || content.lineKey}
                    </Typography>
                  )
                })}
              </Box>
            ))}
          </Box>
          <Chip
            size="small"
            variant="outlined"
            label={`${state.packReview.reservations.length} exact active inventory reservation${state.packReview.reservations.length === 1 ? '' : 's'} retained`}
            sx={{ alignSelf: 'flex-start' }}
          />
          <TextField
            size="small"
            label="Physical pack reason"
            value={packReason}
            disabled={Boolean(packCommand)}
            onChange={(event) => setPackReason(event.target.value)}
            inputProps={{ maxLength: 500 }}
          />
          <FormControlLabel
            control={(
              <Checkbox
                checked={packConfirmed}
                disabled={Boolean(packCommand) || Boolean(state.packReview.blocker)}
                onChange={(event) => setPackConfirmedEvidenceHash(
                  event.target.checked ? packEvidenceHash : null,
                )}
              />
            )}
            label="I physically verified every exact item is in its assigned parcel."
          />
          <Button
            variant="contained"
            disabled={
              Boolean(busy)
              || Boolean(state.packReview.blocker)
              || !state.packReview.evidenceHash
              || Boolean(refreshCommand || purchaseCommand || voidCommand
                || printCommand)
              || (!packCommand && !packConfirmed)
              || (!packCommand && packReason.trim().length < 10)
            }
            onClick={() => { void confirmPack() }}
          >
            {busy === 'pack'
              ? 'Confirming exact physical pack…'
              : packCommand
                ? 'Retry exact pack confirmation'
                : 'Confirm physical pack'}
          </Button>
        </Stack>
      ) : group && (group.active || retryingUnresolvedVoid) ? (
        <Stack spacing={1.25}>
          <Alert severity={group.active ? 'success' : 'warning'}>
            {group.active
              ? `${group.labels.length} active ${group.labels.length === 1 ? 'label' : 'labels'} · master tracking ${group.masterTrackingNumber}`
              : 'The exact cancellation has an unresolved durable outcome.'}
          </Alert>
          {(group.labels.some((label) => Boolean(label.printRecoveryAction))
            || printCommand) && (
            <TextField
              size="small"
              label="Label print recovery reason"
              value={printReason}
              disabled={Boolean(printCommand)}
              onChange={(event) => setPrintReason(event.target.value)}
              inputProps={{ maxLength: 500 }}
              helperText="Required for an exact retry or deliberate new print. This never purchases another carrier label."
            />
          )}
          <Stack spacing={1} data-testid="shipping-one-off-label-print-status">
            {group.labels.map((label) => {
              const retainedForLabel = Boolean(
                printCommand
                && retainedPrintBody?.orderGlobalId === orderGlobalId
                && retainedPrintBody?.labelGlobalId === label.labelGlobalId
                && retainedPrintBody.packageGlobalId === label.packageGlobalId,
              )
              const action = retainedForLabel
                ? retainedPrintBody?.expectedRecoveryAction || null
                : label.printRecoveryAction
              return (
                <Box
                  key={label.labelGlobalId}
                  sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}
                >
                  <Stack
                    direction="row"
                    gap={0.75}
                    flexWrap="wrap"
                    useFlexGap
                    alignItems="center"
                  >
                    <Typography variant="body2" fontWeight={650}>
                      Parcel {label.packageNumber}: {label.trackingNumber}
                    </Typography>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={label.printStatus === 'failed'
                        ? 'warning'
                        : label.printStatus === 'printed'
                          ? 'success'
                          : 'default'}
                      label={label.printStatus
                        ? `Print ${label.printStatus}`
                        : 'Print not queued'}
                    />
                  </Stack>
                  {label.printWarning && (
                    <Typography variant="caption" color="text.secondary">
                      {label.printWarning}
                    </Typography>
                  )}
                  {label.printOutcomeUncertain && (
                    <Alert severity="warning" sx={{ mt: 0.75 }}>
                      Physical output is uncertain. Shipping blocks retry and new print; inspect the printer and use the stronger controlled printer authority if another copy is deliberately required.
                    </Alert>
                  )}
                  {label.printStatus === 'printed' && (
                    <Alert severity="info" sx={{ mt: 0.75 }}>
                      The local print path acknowledged delivery. Shipping will not automatically print this label again.
                    </Alert>
                  )}
                  {action && !label.printOutcomeUncertain && (
                    <Button
                      size="small"
                      variant="outlined"
                      sx={{ mt: 0.75 }}
                      disabled={
                        Boolean(busy)
                        || Boolean(packCommand || refreshCommand
                          || purchaseCommand || voidCommand)
                        || Boolean(printCommand && !retainedForLabel)
                        || (!printCommand && printReason.trim().length < 10)
                      }
                      onClick={() => { void recoverLabelPrint(label) }}
                    >
                      {busy === 'print' && retainedForLabel
                        ? 'Checking exact print recovery…'
                        : retainedForLabel
                          ? 'Retry exact retained print recovery'
                          : action === 'enqueue'
                            ? 'Queue existing label'
                            : action === 'retry'
                              ? 'Retry exact failed print job'
                              : 'Authorize new print after exhausted failure'}
                    </Button>
                  )}
                </Box>
              )
            })}
          </Stack>
          <TextField
            size="small"
            label="Cancellation reason"
            value={voidReason}
            disabled={Boolean(voidCommand)}
            onChange={(event) => setVoidReason(event.target.value)}
            inputProps={{ maxLength: 500 }}
          />
          <Button
            color="warning"
            variant="outlined"
            disabled={
              Boolean(busy)
              || !liveAllowed
              || Boolean(packCommand || refreshCommand || purchaseCommand
                || printCommand)
              || (!voidCommand && voidReason.trim().length < 10)
            }
            onClick={() => { void voidLabels() }}
          >
            {busy === 'void'
              ? 'Checking exact cancellation…'
              : voidCommand
                ? 'Retry exact cancellation'
                : group.lifecycleMode === 'local_sample_close'
                  ? 'Close complete TEST sample group'
                  : 'Void complete carrier label group'}
          </Button>
        </Stack>
      ) : (
        <Stack spacing={1.25}>
          <Button
            variant="outlined"
            disabled={
              Boolean(busy)
              || !state
              || !liveAllowed
              || Boolean(packCommand || purchaseCommand || voidCommand
                || printCommand)
              || unresolved
            }
            onClick={() => { void refreshRates() }}
          >
            {busy === 'refresh'
              ? 'Requesting current packed rates…'
              : refreshCommand
                ? 'Retry exact packed-rate request'
                : 'Get current packed rates'}
          </Button>
          {state?.packedRate && (
            <Typography variant="caption" color="text.secondary">
              Rates expire {new Date(state.packedRate.expiresAt).toLocaleString()}.
            </Typography>
          )}
          {sortedOffers.length > 0 && (
            <TextField
              select
              size="small"
              label="Carrier service"
              value={selectedOfferGlobalId}
              disabled={Boolean(purchaseCommand)}
              onChange={(event) => setSelectedOfferGlobalId(event.target.value)}
            >
              {sortedOffers.map((offer) => (
                <MenuItem
                  key={offer.globalId}
                  value={offer.globalId}
                  disabled={offer.executionCapability !== 'direct_purchase_later'}
                >
                  {offer.providerLabel} · {offer.serviceName} · {money(offer.amountMinor, offer.currency)}
                </MenuItem>
              ))}
            </TextField>
          )}
          <TextField
            size="small"
            label="Label request reason"
            value={purchaseReason}
            disabled={Boolean(purchaseCommand)}
            onChange={(event) => setPurchaseReason(event.target.value)}
            inputProps={{ maxLength: 500 }}
          />
          {live && liveAllowed && (
            <FormControlLabel
              control={<Checkbox checked={liveConfirmed} onChange={(event) => setLiveConfirmed(event.target.checked)} />}
              label="I confirm this LIVE request may purchase production postage for every exact packed parcel."
            />
          )}
          <Button
            variant="contained"
            disabled={
              Boolean(busy)
              || !liveAllowed
              || Boolean(packCommand || refreshCommand || voidCommand
                || printCommand)
              || (!purchaseCommand && !packedRateCurrent)
              || (unresolved && !retryingUnresolvedPurchase)
              || (!purchaseCommand && !selectedOfferGlobalId)
              || (!purchaseCommand && purchaseReason.trim().length < 10)
              || (live && !liveConfirmed)
            }
            onClick={() => { void purchaseLabels() }}
          >
            {busy === 'purchase'
              ? 'Checking exact carrier result…'
              : purchaseCommand
                ? 'Retry exact label request'
                : live
                  ? 'Purchase LIVE postage'
                  : 'Create TEST labels'}
          </Button>
        </Stack>
      )}
    </Stack>
  )
}
