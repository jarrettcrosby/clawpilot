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
  shippingOneOffResponseIsDefinitiveClientRejection,
  type ShippingOneOffCommandAction,
  type ShippingOneOffRetainedCommand,
  writeShippingOneOffRetainedCommand,
} from '@/lib/operations/shippingOneOffRecovery'

type ExecutionPayload = {
  ok?: boolean
  error?: string
  code?: string
  state?: OneOffShipmentExecutionState
  result?: OneOffShippingPackCommandResult
    | OneOffPackedRateRefresh
    | OneOffCarrierGroupCommandResult
}

type CommandAction = ShippingOneOffCommandAction
type RetainedCommand = ShippingOneOffRetainedCommand
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
  command: RetainedCommand | null,
) {
  const storageKey = retainedCommandName(action, orderGlobalId)
  try {
    return writeShippingOneOffRetainedCommand(
      window.sessionStorage,
      storageKey,
      command,
    )
  } catch {
    return false
  }
}

function newCommand(
  action: CommandAction,
  orderGlobalId: string,
  body: PackBody | RefreshBody | PurchaseBody | VoidBody,
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

export function retainedPackReceiptDisposition(
  state: OneOffShipmentExecutionState | null,
  command: RetainedCommand | null,
): RetainedPackReceiptDisposition {
  const body = parsedCommandBody<PackBody>(command)
  const receipt = state?.packReview.receipt
  if (
    !state
    || !command
    || body?.action !== 'confirm-pack'
    || body.orderGlobalId !== state.orderGlobalId
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
) {
  return retainedPackReceiptDisposition(state, command) === 'exact'
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
  const [busy, setBusy] = useState<'pack' | 'refresh' | 'purchase' | 'void' | ''>('')
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
  const [liveConfirmed, setLiveConfirmed] = useState(false)
  const [packCommand, setPackCommand] = useState<RetainedCommand | null>(null)
  const [refreshCommand, setRefreshCommand] = useState<RetainedCommand | null>(null)
  const [purchaseCommand, setPurchaseCommand] = useState<RetainedCommand | null>(null)
  const [voidCommand, setVoidCommand] = useState<RetainedCommand | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const packEvidenceHashRef = useRef<string | null>(null)

  const clearPackCommand = useCallback(() => {
    setPackCommand(null)
    retainCommand('pack', orderGlobalId, null)
  }, [orderGlobalId])

  const clearRefreshCommand = useCallback(() => {
    setRefreshCommand(null)
    retainCommand('packed-rate', orderGlobalId, null)
  }, [orderGlobalId])
  const clearPurchaseCommand = useCallback(() => {
    setPurchaseCommand(null)
    retainCommand('purchase', orderGlobalId, null)
  }, [orderGlobalId])
  const clearVoidCommand = useCallback(() => {
    setVoidCommand(null)
    retainCommand('void', orderGlobalId, null)
  }, [orderGlobalId])

  const loadState = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/operations/one-off-shipments?orderGlobalId=${encodeURIComponent(orderGlobalId)}`,
        { cache: 'no-store' },
      )
      const { malformed, payload } = await readPayload(response)
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
      setError(caught instanceof Error
        ? caught.message
        : 'One-off postage status is unavailable')
      return null
    } finally {
      setLoading(false)
    }
  }, [orderGlobalId])

  useEffect(() => {
    setState(null)
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
    void loadState()
  }, [loadState, orderGlobalId])

  useEffect(() => {
    const packDisposition = retainedPackReceiptDisposition(state, packCommand)
    if (packDisposition !== 'pending') {
      clearPackCommand()
      if (packDisposition === 'superseded') {
        setNotice(
          'Another immutable physical pack receipt completed this order. '
          + 'The older retained request was retired without replay; postage controls are ready.',
        )
      }
    }
    if (refreshIsDurable(state, refreshCommand)) clearRefreshCommand()
    if (purchaseIsDurable(state, purchaseCommand)) clearPurchaseCommand()
    if (voidIsDurable(state, voidCommand)) clearVoidCommand()
  }, [
    clearPackCommand,
    clearPurchaseCommand,
    clearRefreshCommand,
    clearVoidCommand,
    packCommand,
    purchaseCommand,
    refreshCommand,
    state,
    voidCommand,
  ])

  const sortedOffers = useMemo(() => (
    [...(state?.packedRate?.offers || [])].sort((left, right) => (
      left.amountMinor - right.amountMinor
    ))
  ), [state?.packedRate?.offers])

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

  const expiresAt = state?.packedRate
    ? new Date(state.packedRate.expiresAt).getTime()
    : 0
  useEffect(() => {
    if (!expiresAt || expiresAt <= clock) return
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.min(expiresAt - clock + 25, 2_147_483_647),
    )
    return () => window.clearTimeout(timer)
  }, [clock, expiresAt])

  const group = state?.carrierGroup || null
  const live = state?.executionMode === 'live'
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
    state?.packedRate
    && !state.packedRate.consumed
    && state.packedRate.status !== 'failed'
    && expiresAt > clock,
  )
  const packEvidenceHash = state?.packReview.evidenceHash || null
  const packConfirmed = packEvidenceIsAcknowledged(
    packConfirmedEvidenceHash,
    packEvidenceHash,
  )

  const confirmPack = async () => {
    if (
      !state
      || busy
      || !state.packReview.required
      || (!packCommand && !state.packReview.evidenceHash)
      || (!packCommand && !packConfirmed)
      || (!packCommand && packReason.trim().length < 10)
      || refreshCommand
      || purchaseCommand
      || voidCommand
    ) return
    const command = packCommand || newCommand('pack', orderGlobalId, {
      action: 'confirm-pack',
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
      expectedReviewSnapshotHash: state.packReview.evidenceHash!,
      confirmation: ONE_OFF_PACK_CONFIRMATION,
      reason: packReason.trim(),
    })
    setPackCommand(command)
    if (!retainCommand('pack', orderGlobalId, command)) {
      setPackCommand(null)
      setError('Browser retry storage is unavailable. No pack confirmation was sent.')
      return
    }
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
      const { malformed, payload } = await readPayload(response)
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
          if (!durable) {
            throw new Error('The rejected pack confirmation could not be reconciled to durable status')
          }
          if (packIsDurable(durable, command)) {
            clearPackCommand()
            setPackConfirmedEvidenceHash(null)
            setNotice('The prior exact physical pack confirmation succeeded. Current postage controls are ready.')
            await onUpdated()
            return
          }
          if (retainedPackReceiptDisposition(durable, command) === 'superseded') {
            clearPackCommand()
            setError('')
            setNotice(
              'Another immutable physical pack receipt completed this order. '
              + 'The older retained request was retired without replay; postage controls are ready.',
            )
            await onUpdated()
            return
          }
          clearPackCommand()
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
      if (
        !packIsDurable(durable, command)
        || durable?.packReview.receipt?.reviewSnapshotHash
          !== result.reviewSnapshotHash
      ) {
        throw new Error('The pack response is not yet bound to the exact durable review receipt')
      }
      clearPackCommand()
      setPackConfirmedEvidenceHash(null)
      setNotice(
        `${result.packageCount} ${result.packageCount === 1 ? 'parcel is' : 'parcels are'} `
        + 'packed with reservations retained and zero carrier or label writes.',
      )
      await onUpdated()
    } catch (caught) {
      const durable = await loadState()
      if (packIsDurable(durable, command)) {
        clearPackCommand()
        setPackConfirmedEvidenceHash(null)
        setNotice('The prior exact physical pack confirmation succeeded. Current postage controls are ready.')
        await onUpdated()
      } else if (retainedPackReceiptDisposition(durable, command) === 'superseded') {
        clearPackCommand()
        setError('')
        setNotice(
          'Another immutable physical pack receipt completed this order. '
          + 'The older retained request was retired without replay; postage controls are ready.',
        )
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact physical pack confirmation did not complete'}. `
          + 'Check status or retry the retained byte-identical request; do not create a new confirmation.',
        )
      }
    } finally {
      setBusy('')
    }
  }

  const refreshRates = async () => {
    if (
      !state
      || busy
      || !liveAllowed
      || unresolved
      || packCommand
      || purchaseCommand
      || voidCommand
    ) return
    const command = refreshCommand || newCommand('packed-rate', orderGlobalId, {
      action: 'refresh-packed-rates',
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
    })
    setRefreshCommand(command)
    if (!retainCommand('packed-rate', orderGlobalId, command)) {
      setRefreshCommand(null)
      setError('Browser retry storage is unavailable. No carrier rate request was sent.')
      return
    }
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
      const { malformed, payload } = await readPayload(response)
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
          if (!durable) {
            throw new Error('The rejected packed-rate request could not be reconciled to durable status')
          }
          if (refreshIsDurable(durable, command)) {
            clearRefreshCommand()
            setNotice('The prior exact packed-rate request succeeded; durable rates are current.')
            return
          }
          clearRefreshCommand()
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
      if (
        !refreshIsDurable(durable, command)
        || durable?.packedRate?.quoteGlobalId !== result.quote.globalId
      ) {
        throw new Error('The packed-rate response is not yet bound to the exact durable request')
      }
      clearRefreshCommand()
      setNotice(
        `${result.quote.offers.length} current ${result.executionMode.toUpperCase()} `
        + `${result.quote.offers.length === 1 ? 'rate is' : 'rates are'} ready.`,
      )
    } catch (caught) {
      const durable = await loadState()
      if (refreshIsDurable(durable, command)) {
        clearRefreshCommand()
        setNotice('The prior exact packed-rate request succeeded; durable rates are current.')
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'Current packed rates did not complete'}. `
          + 'The byte-identical request and key are retained; check status or retry this exact request.',
        )
      }
    } finally {
      setBusy('')
    }
  }

  const purchaseLabels = async () => {
    if (
      !state
      || busy
      || !liveAllowed
      || Boolean(packCommand || refreshCommand || voidCommand)
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
    setPurchaseCommand(command)
    if (!retainCommand('purchase', orderGlobalId, command)) {
      setPurchaseCommand(null)
      setError('Browser retry storage is unavailable. No carrier label request was sent.')
      return
    }
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
      const { malformed, payload } = await readPayload(response)
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
          if (!durable) {
            throw new Error('The rejected label request could not be reconciled to durable status')
          }
          if (purchaseIsDurable(durable, command)) {
            clearPurchaseCommand()
            setLiveConfirmed(false)
            setNotice('The prior exact label request succeeded; its durable labels are shown below.')
            await onUpdated()
            return
          }
          clearPurchaseCommand()
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
      if (
        !purchaseIsDurable(durable, command)
        || durable?.carrierGroup?.createAttemptGlobalId !== result.groupAttemptGlobalId
      ) {
        throw new Error('The label response is not yet bound to the exact order, quote, offer, and request key')
      }
      clearPurchaseCommand()
      setLiveConfirmed(false)
      setNotice(
        `${result.executionMode.toUpperCase()} carrier group `
        + `${result.groupAttemptGlobalId} returned ${result.labels.length} `
        + `${result.labels.length === 1 ? 'label' : 'labels'}.`,
      )
      await onUpdated()
    } catch (caught) {
      const durable = await loadState()
      if (purchaseIsDurable(durable, command)) {
        clearPurchaseCommand()
        setLiveConfirmed(false)
        setNotice('The prior exact label request succeeded; its durable labels are shown below.')
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact carrier label request did not complete'}. `
          + 'Do not start a new request. Check durable status or retry the retained byte-identical request.',
        )
      }
    } finally {
      setBusy('')
    }
  }

  const voidLabels = async () => {
    if (
      !state
      || (!group?.active && !retryingUnresolvedVoid)
      || busy
      || !liveAllowed
      || Boolean(packCommand || refreshCommand || purchaseCommand)
      || (!voidCommand && voidReason.trim().length < 10)
    ) return
    const command = voidCommand || newCommand('void', orderGlobalId, {
      action: 'void-group',
      orderGlobalId,
      expectedRowVersion: state.rowVersion,
      reason: voidReason.trim(),
    })
    setVoidCommand(command)
    if (!retainCommand('void', orderGlobalId, command)) {
      setVoidCommand(null)
      setError('Browser retry storage is unavailable. No carrier cancellation was sent.')
      return
    }
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
      const { malformed, payload } = await readPayload(response)
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
          if (!durable) {
            throw new Error('The rejected cancellation could not be reconciled to durable status')
          }
          if (voidIsDurable(durable, command)) {
            clearVoidCommand()
            setNotice('The prior exact cancellation succeeded; durable status is current.')
            await onUpdated()
            return
          }
          clearVoidCommand()
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
      if (
        !voidIsDurable(durable, command)
        || durable?.carrierGroup?.voidAttemptGlobalId !== result.groupAttemptGlobalId
      ) {
        throw new Error('The cancellation response is not yet bound to the exact carrier group and request key')
      }
      clearVoidCommand()
      setNotice(
        result.action === 'close_sample'
          ? 'The complete TEST sample label group was closed locally with zero provider writes.'
          : 'The complete carrier label group was voided.',
      )
      await onUpdated()
    } catch (caught) {
      const durable = await loadState()
      if (voidIsDurable(durable, command)) {
        clearVoidCommand()
        setNotice('The prior exact cancellation succeeded; durable status is current.')
        await onUpdated()
      } else {
        setError(
          `${caught instanceof Error ? caught.message : 'The exact carrier cancellation did not complete'}. `
          + 'Do not create a new cancellation. Check status or retry the retained byte-identical request.',
        )
      }
    } finally {
      setBusy('')
    }
  }

  if (loading && !state) {
    return <Typography color="text.secondary">Loading exact postage status…</Typography>
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
          disabled={Boolean(busy)}
          onClick={() => { setError(''); void loadState() }}
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
      {(packCommand || refreshCommand || purchaseCommand || voidCommand) && (
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
              || Boolean(refreshCommand || purchaseCommand || voidCommand)
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
          <Box>
            {group.labels.map((label) => (
              <Typography key={label.labelGlobalId} variant="body2">
                Parcel {label.packageNumber}: {label.trackingNumber}
                {label.printWarning ? ` · ${label.printWarning}` : ''}
              </Typography>
            ))}
          </Box>
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
              || Boolean(packCommand || refreshCommand || purchaseCommand)
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
              || Boolean(packCommand || purchaseCommand || voidCommand)
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
              || Boolean(packCommand || refreshCommand || voidCommand)
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
